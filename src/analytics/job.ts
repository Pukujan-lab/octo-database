/**
 * The `analytics_query` job (Slice 7).
 *
 * One job = one named query over one immutable dataset version. The payload
 * carries ids only; the catalog row is the authority for the object keys and
 * schema, and every key is asserted against the job's workspace before it is
 * read or written.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ObjectStore } from '../storage/object-store';
import {
  analyticsEngineStatus,
  prepareJobDirectory,
  removeJobDirectory,
  runSpecOverParquetFiles,
  runWorkspaceSql,
} from './engine';
import { assertWorkspaceKey, resultObjectKey } from './paths';
import { carriesSpecInputs, coerceParams, getQuerySpec, parseWorkspaceSpecId } from './specs';
import { SINK_SCHEMA as SINK_LABEL, validateSink } from './sink';
import type { AnalyticsSink, DatasetVersionRecord, WorkspaceSpecRecord } from '../types/analytics';

export interface AnalyticsJobDeps {
  store: ObjectStore;
  loadVersion: (workspaceId: string, datasetVersionId: string) => Promise<DatasetVersionRecord | null>;
  loadWorkspaceSpec: (workspaceId: string, slug: string, version: number) => Promise<WorkspaceSpecRecord | null>;
  /** Lands a scheduled run's rows in the workspace database. Absent when none is wired. */
  writeSink?: (input: { workspaceId: string; sink: AnalyticsSink; resultBytes: Buffer }) => Promise<{ rowsWritten: number }>;
  registerResult: (input: {
    workspaceId: string;
    datasetVersionId: string;
    jobId: string;
    resultId: string;
    querySpec: string;
    objectKey: string;
    rowCount: number;
    contentHash: string;
    engineVersion: string;
  }) => Promise<void>;
}

export type AnalyticsJobResult =
  | { ok: true; detail: string }
  | { ok: false; code: string; summary: string; retryable: boolean };

function failure(code: string, summary: string, retryable = false): AnalyticsJobResult {
  return { ok: false, code, summary, retryable };
}

export async function runAnalyticsJob(
  job: { jobId: string; workspaceId: string; payload: Record<string, unknown> },
  deps: AnalyticsJobDeps
): Promise<AnalyticsJobResult> {
  const datasetVersionId = job.payload['datasetVersionId'];
  const querySpec = job.payload['querySpec'];
  const resultId = job.payload['resultId'];
  if (
    typeof datasetVersionId !== 'string' ||
    typeof querySpec !== 'string' ||
    typeof resultId !== 'string'
  ) {
    return failure('INVALID_PAYLOAD', 'analytics job payload must carry datasetVersionId, querySpec, and resultId');
  }

  let sink: AnalyticsSink | null = null;
  if (job.payload['sink'] !== undefined) {
    const parsed = validateSink(job.payload['sink']);
    if (!parsed.ok) return failure('INVALID_PAYLOAD', parsed.message);
    if (!deps.writeSink) return failure('SINK_NOT_CONFIGURED', 'this worker cannot write to workspace databases');
    sink = parsed.sink;
  }

  const workspaceRef = parseWorkspaceSpecId(querySpec);
  const spec = workspaceRef ? null : getQuerySpec(querySpec);
  if (!workspaceRef && !spec) return failure('INVALID_PAYLOAD', `unknown query spec ${querySpec}`);

  let workspaceSpec: WorkspaceSpecRecord | null = null;
  let paramValues: Record<string, string | number | boolean> = {};
  if (workspaceRef) {
    workspaceSpec = await deps.loadWorkspaceSpec(job.workspaceId, workspaceRef.slug, workspaceRef.version);
    if (!workspaceSpec) return failure('SPEC_NOT_FOUND', `spec ${querySpec} is not in this workspace`);
    const coerced = coerceParams(workspaceSpec.params, job.payload['params']);
    if (!coerced.ok) return failure('INVALID_PAYLOAD', coerced.message);
    paramValues = coerced.values;
  }

  const version = await deps.loadVersion(job.workspaceId, datasetVersionId);
  if (!version) {
    return failure('DATASET_VERSION_NOT_FOUND', `dataset version ${datasetVersionId} is not in this workspace`);
  }
  if (spec && !carriesSpecInputs(version.schema, spec)) {
    return failure('SCHEMA_MISMATCH', `dataset version ${datasetVersionId} no longer carries the spec inputs`);
  }

  const engine = await analyticsEngineStatus();
  if (!engine.configured) return failure('ANALYTICS_NOT_CONFIGURED', 'the analytics engine is not configured');

  const dir = prepareJobDirectory(job.jobId);
  try {
    const files: string[] = [];
    for (let index = 0; index < version.objectKeys.length; index += 1) {
      const key = version.objectKeys[index]!;
      assertWorkspaceKey(key, job.workspaceId);
      const bytes = await deps.store.get(key);
      if (!bytes) return failure('PARQUET_MISSING', `dataset part ${key} is missing`);
      const file = path.join(dir, `part-${index}.parquet`);
      fs.writeFileSync(file, bytes);
      files.push(file);
    }

    const outFile = path.join(dir, 'result.parquet');
    const spillDir = path.join(dir, 'spill');
    const run = workspaceSpec
      ? await runWorkspaceSql({
          sql: workspaceSpec.sql,
          params: workspaceSpec.params,
          values: paramValues,
          files,
          outFile,
          spillDir,
        })
      : await runSpecOverParquetFiles({ spec: spec!, files, outFile, spillDir });
    if (!run.ok) return run;

    const objectKey = resultObjectKey(job.workspaceId, resultId);
    assertWorkspaceKey(objectKey, job.workspaceId);
    await deps.store.put(objectKey, run.bytes, 'application/vnd.apache.parquet');

    const contentHash = createHash('sha256').update(run.bytes).digest('hex');
    await deps.registerResult({
      workspaceId: job.workspaceId,
      datasetVersionId,
      jobId: job.jobId,
      resultId,
      querySpec,
      objectKey,
      rowCount: run.rowCount,
      contentHash,
      engineVersion: run.engineVersion,
    });

    let sinkNote = '';
    if (sink) {
      try {
        const written = await deps.writeSink!({ workspaceId: job.workspaceId, sink, resultBytes: run.bytes });
        sinkNote = `; wrote ${written.rowsWritten} row(s) to ${SINK_LABEL}.${sink.table}`;
      } catch (error) {
        return failure('SINK_ERROR', error instanceof Error ? error.message : String(error));
      }
    }

    return {
      ok: true,
      detail: `${querySpec} over ${version.objectKeys.length} part(s) -> ${run.rowCount} row(s)${sinkNote}`,
    };
  } finally {
    removeJobDirectory(dir);
  }
}
