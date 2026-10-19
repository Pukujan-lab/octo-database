/**
 * Unit tests: the analytics_query job (Slice 7).
 *
 * The job reads one immutable dataset version, runs the named spec, writes the
 * result artifact, and records it. These tests pin the fail-closed paths: an
 * unknown spec, a missing part, and a catalog row whose keys point outside the
 * job's workspace.
 */

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsJobDeps, runAnalyticsJob } from '../../src/analytics/job';
import { readParquetRows } from '../../src/analytics/engine';
import { resultObjectKey } from '../../src/analytics/paths';
import { LocalObjectStore } from '../../src/storage/object-store';
import type { DatasetVersionRecord } from '../../src/types/analytics';
import { parquetBytes, readResultRows, JobRow } from './analytics-test-helpers';

const ROOT = path.join(os.tmpdir(), `octo-analytics-job-${randomUUID()}`);
const STORE = new LocalObjectStore(ROOT);
const WORKSPACE = randomUUID();

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const ROWS: JobRow[] = [
  { job_type: 'archive_file', state: 'failed', created_at: '2026-01-02 00:00:00' },
  { job_type: 'archive_file', state: 'failed', created_at: '2026-01-03 00:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-02-04 00:00:00' },
];

async function seedVersion(workspaceId = WORKSPACE): Promise<DatasetVersionRecord> {
  const key = `workspaces/${workspaceId}/lake/job-history/v1/dt=2026-02-28/part-${randomUUID()}.parquet`;
  await STORE.put(key, await parquetBytes(ROWS), 'application/vnd.apache.parquet');
  return {
    id: randomUUID(),
    datasetId: randomUUID(),
    dataset: 'job-history',
    version: 1,
    format: 'parquet',
    schema: [
      { name: 'job_type', type: 'TEXT' },
      { name: 'state', type: 'TEXT' },
      { name: 'created_at', type: 'TIMESTAMP' },
    ],
    objectKeys: [key],
    rowCount: ROWS.length,
    provenance: { source: 'test', exportedAt: '2026-10-19T00:00:00Z' },
    watermark: null,
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function deps(version: DatasetVersionRecord | null) {
  const registered: Array<Record<string, unknown>> = [];
  return {
    registered,
    deps: {
      store: STORE,
      loadVersion: async () => version,
      registerResult: async (input: Parameters<AnalyticsJobDeps['registerResult']>[0]) => {
        registered.push(input as unknown as Record<string, unknown>);
      },
    },
  };
}

function job(payload: Record<string, unknown>, workspaceId = WORKSPACE) {
  return { jobId: randomUUID(), workspaceId, payload };
}

describe('analytics_query job', () => {
  it('runs the named spec, writes the result, and records its hash', async () => {
    const version = await seedVersion();
    const resultId = randomUUID();
    const { registered, deps: d } = deps(version);

    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1', resultId }),
      d
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.summary);

    const expectedKey = resultObjectKey(WORKSPACE, resultId);
    const bytes = await STORE.get(expectedKey);
    expect(bytes).not.toBeNull();
    expect(await readResultRows(bytes!)).toEqual([
      { job_type: 'archive_file', month: '2026-01-01', failure_count: 2 },
      { job_type: 'thumbnail', month: '2026-02-01', failure_count: 1 },
    ]);

    expect(registered).toHaveLength(1);
    const record = registered[0]!;
    expect(record['objectKey']).toBe(expectedKey);
    expect(record['rowCount']).toBe(2);
    expect(record['contentHash']).toBe(createHash('sha256').update(bytes!).digest('hex'));
    expect(record['engineVersion']).toMatch(/^v?\d+\.\d+\.\d+/);
    expect(record['workspaceId']).toBe(WORKSPACE);
    expect(record['jobId']).toBeTruthy();
    expect(record['resultId']).toBe(resultId);
  });

  it('fails a malformed payload without retrying', async () => {
    const version = await seedVersion();
    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1' }),
      deps(version).deps
    );

    expect(outcome).toEqual({
      ok: false,
      code: 'INVALID_PAYLOAD',
      summary: expect.stringContaining('resultId'),
      retryable: false,
    });
  });

  it('fails an unknown query spec without retrying', async () => {
    const version = await seedVersion();
    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'raw-sql@1', resultId: randomUUID() }),
      deps(version).deps
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('INVALID_PAYLOAD');
    expect(outcome.retryable).toBe(false);
  });

  it('fails when the version is not in the job workspace', async () => {
    const version = await seedVersion();
    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1', resultId: randomUUID() }, randomUUID()),
      deps(null).deps
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('DATASET_VERSION_NOT_FOUND');
  });

  it('fails when a dataset part is missing from the object store', async () => {
    const version = await seedVersion();
    version.objectKeys = [`workspaces/${WORKSPACE}/lake/job-history/v1/dt=2026-02-28/part-gone.parquet`];

    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1', resultId: randomUUID() }),
      deps(version).deps
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('PARQUET_MISSING');
  });

  it('MR-C: refuses a catalog key outside the job workspace', async () => {    const other = randomUUID();
    const version = await seedVersion(other);

    await expect(
      runAnalyticsJob(
        job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1', resultId: randomUUID() }),
        deps(version).deps
      )
    ).rejects.toThrow(/UNSAFE_OBJECT_KEY/);
  });

  it('reads a result artifact back as JSON rows for the dashboard', async () => {
    const version = await seedVersion();
    const resultId = randomUUID();
    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1', resultId }),
      deps(version).deps
    );
    if (!outcome.ok) throw new Error(outcome.summary);

    const bytes = await STORE.get(resultObjectKey(WORKSPACE, resultId));
    if (!bytes) throw new Error('the result artifact is missing');
    const rows = await readParquetRows(bytes);

    expect(rows.columns).toEqual(['job_type', 'month', 'failure_count']);
    expect(rows.rowCount).toBe(2);
    expect(rows.truncated).toBe(false);
    expect(rows.rows).toEqual([
      { job_type: 'archive_file', month: '2026-01-01 00:00:00', failure_count: 2 },
      { job_type: 'thumbnail', month: '2026-02-01 00:00:00', failure_count: 1 },
    ]);
  });

  it('caps the dashboard row read and reports the truncation', async () => {
    const version = await seedVersion();
    const resultId = randomUUID();
    const outcome = await runAnalyticsJob(
      job({ datasetVersionId: version.id, querySpec: 'job-failures-by-type-month@1', resultId }),
      deps(version).deps
    );
    if (!outcome.ok) throw new Error(outcome.summary);

    const bytes = await STORE.get(resultObjectKey(WORKSPACE, resultId));
    if (!bytes) throw new Error('the result artifact is missing');
    const rows = await readParquetRows(bytes, 1);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rowCount).toBe(2);
    expect(rows.truncated).toBe(true);
  });
});
