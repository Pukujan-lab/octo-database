/**
 * Ephemeral DuckDB compute (Slice 7).
 *
 * DuckDB runs in-process for the duration of one job: read the dataset's Parquet
 * parts, answer the named spec, write a result Parquet, tear everything down.
 * There is no persistent DuckDB file and no separate service.
 *
 * The native module is loaded lazily. A load failure must not prevent the API
 * from booting; it surfaces as `analytics.configured = false` on /health and as
 * `503 ANALYTICS_NOT_CONFIGURED` on the analytics routes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { QuerySpec, sqlLiteral } from './specs';
import type { ColumnSpec } from '../types/analytics';

export const ANALYTICS_MAX_MEMORY = '512MB';
export const ANALYTICS_QUERY_TIMEOUT_MS = 30000;

type DuckDbModule = typeof import('@duckdb/node-api');

let modulePromise: Promise<DuckDbModule | null> | null = null;
let moduleError: string | null = null;
let cachedVersion: string | null = null;

function loadModule(): Promise<DuckDbModule | null> {
  if (!modulePromise) {
    modulePromise = import('@duckdb/node-api')
      .then((loaded) => loaded)
      .catch((error: unknown) => {
        moduleError = error instanceof Error ? error.message : String(error);
        return null;
      });
  }
  return modulePromise;
}

async function openInstance(): Promise<{ instance: DuckDBInstance; connection: DuckDBConnection }> {
  const module = await loadModule();
  if (!module) {
    throw new Error(`DUCKDB_UNAVAILABLE: ${moduleError ?? 'the native module failed to load'}`);
  }
  const instance = await module.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  // Month bucketing is defined in UTC. A TIMESTAMPTZ is truncated in the
  // session timezone, so a host in a negative-offset zone would otherwise push
  // the first hours of a month into the previous one.
  await connection.run("SET TimeZone = 'UTC'");
  return { instance, connection };
}

function closeQuietly(instance: DuckDBInstance | null, connection: DuckDBConnection | null): void {
  try {
    connection?.closeSync();
  } catch {
    // ignore
  }
  try {
    instance?.closeSync();
  } catch {
    // ignore
  }
}

export interface AnalyticsEngineStatus {
  configured: boolean;
  engine: 'duckdb';
  version: string | null;
}

/** Probes the pinned native module and caches its engine version. */
export async function analyticsEngineStatus(): Promise<AnalyticsEngineStatus> {
  if (cachedVersion) return { configured: true, engine: 'duckdb', version: cachedVersion };

  const module = await loadModule();
  if (!module) return { configured: false, engine: 'duckdb', version: null };

  let instance: DuckDBInstance | null = null;
  let connection: DuckDBConnection | null = null;
  try {
    ({ instance, connection } = await openInstance());
    const rows = await (await connection.run('SELECT version() AS version')).getRowObjects();
    const version = rows[0]?.['version'];
    cachedVersion = typeof version === 'string' ? version : String(version ?? 'unknown');
    return { configured: true, engine: 'duckdb', version: cachedVersion };
  } catch {
    return { configured: false, engine: 'duckdb', version: null };
  } finally {
    closeQuietly(instance, connection);
  }
}

export interface ParquetInspection {
  columns: ColumnSpec[];
  rowCount: number;
}

/**
 * Reads a Parquet file's footer: column names/types in file order and its row
 * count. Throws when the file is not valid Parquet.
 */
export async function inspectParquetFile(file: string): Promise<ParquetInspection> {
  const { instance, connection } = await openInstance();
  try {
    const described = await (
      await connection.run(`DESCRIBE SELECT * FROM read_parquet(${sqlLiteral(file)})`)
    ).getRowObjects();
    const columns = described.map((row) => ({
      name: String(row['column_name']),
      type: String(row['column_type']),
    }));
    const counted = await (
      await connection.run(`SELECT count(*)::BIGINT AS n FROM read_parquet(${sqlLiteral(file)})`)
    ).getRowObjects();
    const raw = counted[0]?.['n'];
    return { columns, rowCount: Number(raw ?? 0) };
  } finally {
    closeQuietly(instance, connection);
  }
}

export type AnalyticsRunResult =
  | { ok: true; bytes: Buffer; rowCount: number; engineVersion: string }
  | { ok: false; code: string; summary: string; retryable: boolean };

/** Maps a DuckDB error to the stable job-level code the status route reports. */
function classifyEngineError(error: unknown, timedOut: boolean): { code: string; summary: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut) return { code: 'QUERY_TIMEOUT', summary: `query exceeded its time limit: ${message}` };
  if (/interrupt|cancell?ed/i.test(message)) {
    return { code: 'QUERY_CANCELLED', summary: `query was cancelled: ${message}` };
  }
  if (/no files found|no such file|does not exist|cannot open file/i.test(message)) {
    return { code: 'PARQUET_MISSING', summary: message };
  }
  return { code: 'PARQUET_CORRUPT', summary: message };
}

/**
 * Runs one named spec over the supplied Parquet files and writes the result
 * Parquet to `outFile`. `spillDir` bounds DuckDB's temporary storage.
 */
export async function runSpecOverParquetFiles(input: {
  spec: QuerySpec;
  files: string[];
  outFile: string;
  spillDir: string;
  timeoutMs?: number;
}): Promise<AnalyticsRunResult> {
  const timeoutMs = input.timeoutMs ?? ANALYTICS_QUERY_TIMEOUT_MS;
  fs.mkdirSync(input.spillDir, { recursive: true });

  const { instance, connection } = await openInstance();
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  try {
    await connection.run(`SET max_memory = ${sqlLiteral(ANALYTICS_MAX_MEMORY)}`);
    await connection.run('SET threads = 2');
    await connection.run(`SET temp_directory = ${sqlLiteral(input.spillDir)}`);

    timer = setTimeout(() => {
      timedOut = true;
      try {
        connection.interrupt();
      } catch {
        // ignore: the run's rejection carries the outcome
      }
    }, timeoutMs);

    const sql = input.spec.buildSql(input.files);
    await connection.run(
      `COPY (${sql}) TO ${sqlLiteral(input.outFile)} (FORMAT PARQUET)`
    );

    const counted = await (
      await connection.run(
        `SELECT count(*)::BIGINT AS n FROM read_parquet(${sqlLiteral(input.outFile)})`
      )
    ).getRowObjects();
    const raw = counted[0]?.['n'];
    const versionRows = await (await connection.run('SELECT version() AS version')).getRowObjects();
    const version = versionRows[0]?.['version'];

    return {
      ok: true,
      bytes: fs.readFileSync(input.outFile),
      rowCount: Number(raw ?? 0),
      engineVersion: typeof version === 'string' ? version : String(version ?? 'unknown'),
    };
  } catch (error) {
    const classified = classifyEngineError(error, timedOut);
    return { ok: false, ...classified, retryable: false };
  } finally {
    if (timer) clearTimeout(timer);
    closeQuietly(instance, connection);
  }
}

/** Creates (and clears) the per-job temp directory. */
export function prepareJobDirectory(jobId: string): string {
  const root = process.env['OCTO_ANALYTICS_TMP'] ?? path.join(os.tmpdir(), 'octo-analytics');
  const dir = path.join(root, jobId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeJobDirectory(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
