/**
 * Dataset registration (Slice 7).
 *
 * A registration is an immutable export: the caller supplies Parquet parts and a
 * declared schema, the server validates the footer, assigns the next version,
 * derives every object key, writes the bytes, and records the catalog row in one
 * locked transaction. A re-export is a new version; nothing is mutated.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ObjectStore } from '../storage/object-store';
import {
  DATASET_SLUG_PATTERN,
  assertWorkspaceKey,
  datasetPartKey,
  isValidPartition,
} from './paths';
import { analyticsEngineStatus, inspectParquetFile, prepareJobDirectory, removeJobDirectory } from './engine';
import { schemaMatchesDeclared, validateDeclaredSchema } from './specs';
import type { ColumnSpec, DatasetVersionRecord } from '../types/analytics';

export interface RegisterVersionInput {
  workspaceId: string;
  createdBy: string;
  slug: string;
  name: string | null;
  format: string;
  schema: ColumnSpec[];
  provenance: Record<string, unknown>;
  watermark: string | null;
  rowCount: number;
  idempotencyKey: string | null;
  buildObjectKeys: (version: number) => string[];
  writeObjects: (keys: string[]) => Promise<void>;
  /**
   * Set when the new version extends an earlier one: it must be built on exactly
   * `baseVersion` (else the write is a conflict) and carries `carryKeys` forward
   * without re-uploading them. `rowCount` then counts the new parts only.
   */
  append: { baseVersion: number; carryKeys: string[]; baseRowCount: number } | null;
}

export type RegisterVersionResult =
  | { status: 'created' | 'existing'; version: DatasetVersionRecord }
  | { status: 'conflict' };

export interface AnalyticsCatalogWriter {
  createVersion(input: RegisterVersionInput): Promise<RegisterVersionResult>;
  /** The newest version of a dataset, used as the base of an append. */
  latestVersion(workspaceId: string, slug: string): Promise<DatasetVersionRecord | null>;
}

export type RegisterOutcome =
  | { ok: true; created: boolean; version: DatasetVersionRecord }
  | { ok: false; http: number; error: string; message: string };

interface ParsedPart {
  partition: string;
  bytes: Buffer;
}

/** The `YYYY-MM-DD` of a part key laid out by `datasetPartKey`. */
function partitionOfKey(key: string): string {
  return /\/dt=(\d{4}-\d{2}-\d{2})\//.exec(key)?.[1] ?? '';
}

function bad(message: string, error = 'BAD_REQUEST'): RegisterOutcome {
  return { ok: false, http: 400, error, message };
}

function parseParts(raw: unknown): ParsedPart[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'parts must be a non-empty array';
  const parts: ParsedPart[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!entry || typeof entry !== 'object') return `parts[${index}] must be { partition, dataBase64 }`;
    const partition = (entry as { partition?: unknown }).partition;
    const dataBase64 = (entry as { dataBase64?: unknown }).dataBase64;
    if (typeof partition !== 'string' || !isValidPartition(partition)) {
      return `parts[${index}].partition must be a real YYYY-MM-DD date`;
    }
    if (
      typeof dataBase64 !== 'string' ||
      dataBase64.length === 0 ||
      dataBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      return `parts[${index}].dataBase64 must be non-empty base64`;
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0) return `parts[${index}].dataBase64 decoded to zero bytes`;
    parts.push({ partition, bytes });
  }
  return parts;
}

/**
 * Validates the request, inspects the Parquet footers, and hands the locked
 * catalog write to the caller-supplied catalog. The engine probe happens after
 * the route's workspace fence, never before.
 */
export async function registerDatasetVersion(
  input: {
    workspaceId: string;
    createdBy: string;
    body: Record<string, unknown>;
    store: ObjectStore;
  },
  catalog: AnalyticsCatalogWriter
): Promise<RegisterOutcome> {
  const body = input.body;
  const dataset = body['dataset'];
  if (typeof dataset !== 'string' || !DATASET_SLUG_PATTERN.test(dataset)) {
    return bad('dataset must be a lowercase slug matching [a-z0-9-]');
  }
  if (body['format'] !== 'parquet') {
    return bad('format must be "parquet"');
  }

  const schema = body['schema'] as ColumnSpec[] | undefined;
  const schemaError = validateDeclaredSchema(schema);
  if (schemaError) return bad(schemaError);
  const declared = schema!;

  const provenance = body['provenance'];
  if (
    !provenance ||
    typeof provenance !== 'object' ||
    Array.isArray(provenance) ||
    typeof (provenance as { source?: unknown }).source !== 'string' ||
    typeof (provenance as { exportedAt?: unknown }).exportedAt !== 'string'
  ) {
    return bad('provenance must be an object with source and exportedAt strings');
  }

  const watermark = body['watermark'];
  if (watermark !== undefined && (typeof watermark !== 'string' || !watermark.trim())) {
    return bad('watermark must be a non-empty string when supplied');
  }

  const name = body['name'];
  if (name !== undefined && typeof name !== 'string') {
    return bad('name must be a string when supplied');
  }

  const idempotencyKey = body['idempotencyKey'];
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200)
  ) {
    return bad('idempotencyKey must be a non-empty string of at most 200 characters');
  }

  const parsedParts = parseParts(body['parts']);
  if (typeof parsedParts === 'string') return bad(parsedParts);

  // `append: true` extends the newest version with new partitions. The result is
  // still a new immutable version; the earlier parts are referenced, not copied.
  const appendRequested = body['append'];
  if (appendRequested !== undefined && typeof appendRequested !== 'boolean') {
    return bad('append must be a boolean when supplied');
  }
  let base: DatasetVersionRecord | null = null;
  if (appendRequested) {
    base = await catalog.latestVersion(input.workspaceId, dataset);
    if (!base) {
      return { ok: false, http: 404, error: 'DATASET_NOT_FOUND', message: 'nothing to append to; register the dataset first' };
    }
    if (!schemaMatchesDeclared(base.schema, declared)) {
      return { ok: false, http: 400, error: 'SCHEMA_MISMATCH', message: 'an append must use the dataset\'s existing schema' };
    }
    const existing = new Set(base.objectKeys.map(partitionOfKey));
    for (const part of parsedParts) {
      if (existing.has(part.partition)) {
        return { ok: false, http: 409, error: 'PARTITION_EXISTS', message: `partition ${part.partition} is already in this dataset` };
      }
    }
    const incoming = new Set(parsedParts.map((part) => part.partition));
    if (incoming.size !== parsedParts.length) return bad('parts must not repeat a partition');
  }

  const engine = await analyticsEngineStatus();
  if (!engine.configured) {
    return {
      ok: false,
      http: 503,
      error: 'ANALYTICS_NOT_CONFIGURED',
      message: 'the analytics engine or object store is not configured',
    };
  }

  const dir = prepareJobDirectory(`register-${randomUUID()}`);
  try {
    const files: string[] = [];
    for (let index = 0; index < parsedParts.length; index += 1) {
      const file = path.join(dir, `part-${index}.parquet`);
      fs.writeFileSync(file, parsedParts[index]!.bytes);
      files.push(file);
    }

    let rowCount = 0;
    let actualSchema: ColumnSpec[] | null = null;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      let inspection;
      try {
        inspection = await inspectParquetFile(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return bad(`parts[${index}] is not valid Parquet: ${message}`);
      }
      if (index === 0) {
        actualSchema = inspection.columns;
        if (!schemaMatchesDeclared(declared, inspection.columns)) {
          return {
            ok: false,
            http: 400,
            error: 'SCHEMA_MISMATCH',
            message: `declared schema does not match the Parquet footer: ${inspection.columns
              .map((c) => `${c.name} ${c.type}`)
              .join(', ')}`,
          };
        }
      } else if (!schemaMatchesDeclared(declared, inspection.columns)) {
        return {
          ok: false,
          http: 400,
          error: 'SCHEMA_MISMATCH',
          message: `parts[${index}] does not match the declared schema`,
        };
      }
      rowCount += inspection.rowCount;
    }
    if (!actualSchema) return bad('parts must contain at least one Parquet file');

    // Part ids are generated once so the keys are stable across the locked write.
    const partIds = parsedParts.map(() => randomUUID());
    const buildObjectKeys = (version: number): string[] =>
      parsedParts.map((part, index) => {
        const key = datasetPartKey({
          workspaceId: input.workspaceId,
          datasetSlug: dataset,
          version,
          partition: part.partition,
          partId: partIds[index]!,
        });
        assertWorkspaceKey(key, input.workspaceId);
        return key;
      });

    const writeObjects = async (keys: string[]): Promise<void> => {
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        assertWorkspaceKey(key, input.workspaceId);
        await input.store.put(key, parsedParts[index]!.bytes, 'application/vnd.apache.parquet');
      }
    };

    const result = await catalog.createVersion({
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      slug: dataset,
      name: typeof name === 'string' ? name : null,
      format: 'parquet',
      schema: declared,
      provenance: provenance as Record<string, unknown>,
      watermark: typeof watermark === 'string' ? watermark : null,
      rowCount: base ? base.rowCount + rowCount : rowCount,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
      buildObjectKeys,
      writeObjects,
      append: base
        ? { baseVersion: base.version, carryKeys: base.objectKeys, baseRowCount: base.rowCount }
        : null,
    });

    if (result.status === 'conflict') {
      return {
        ok: false,
        http: 409,
        error: 'DATASET_VERSION_CONFLICT',
        message: 'a concurrent registration assigned the same version; retry',
      };
    }
    return { ok: true, created: result.status === 'created', version: result.version };
  } finally {
    removeJobDirectory(dir);
  }
}
