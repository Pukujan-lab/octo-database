/**
 * Unit tests: workspace-registered analytics specs.
 *
 * The fence is the engine, not the SQL text: a spec reads only the dataset parts
 * the job mounted as `data`, and nothing else on disk or the network.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsJobDeps, runAnalyticsJob } from '../../src/analytics/job';
import { readParquetRows, validateWorkspaceSql } from '../../src/analytics/engine';
import { coerceParams, parseWorkspaceSpecId, validateParamDecls } from '../../src/analytics/specs';
import { LocalObjectStore } from '../../src/storage/object-store';
import type { DatasetVersionRecord, SpecParam, WorkspaceSpecRecord } from '../../src/types/analytics';
import { JobRow, parquetBytes, tempPath } from './analytics-test-helpers';

const ROOT = path.join(os.tmpdir(), `octo-analytics-wsspec-${randomUUID()}`);
const STORE = new LocalObjectStore(ROOT);
const WORKSPACE = randomUUID();

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const SCHEMA = [
  { name: 'job_type', type: 'TEXT' },
  { name: 'state', type: 'TEXT' },
  { name: 'created_at', type: 'TIMESTAMP' },
];

const ROWS: JobRow[] = [
  { job_type: 'archive_file', state: 'failed', created_at: '2026-01-02 00:00:00' },
  { job_type: 'archive_file', state: 'failed', created_at: '2026-03-03 00:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-02-04 00:00:00' },
];

async function seedVersion(): Promise<DatasetVersionRecord> {
  const key = `workspaces/${WORKSPACE}/lake/jobs/v1/dt=2026-03-04/part-${randomUUID()}.parquet`;
  await STORE.put(key, await parquetBytes(ROWS), 'application/vnd.apache.parquet');
  return {
    id: randomUUID(),
    datasetId: randomUUID(),
    dataset: 'jobs',
    version: 1,
    format: 'parquet',
    schema: SCHEMA,
    objectKeys: [key],
    rowCount: ROWS.length,
    provenance: { source: 'test', exportedAt: '2026-10-30T00:00:00Z' },
    watermark: null,
    createdAt: '2026-10-30T00:00:00.000Z',
  };
}

function spec(sql: string, params: SpecParam[] = []): WorkspaceSpecRecord {
  return { id: randomUUID(), slug: 'q', version: 1, specId: 'ws:q@1', sql, params, createdAt: '2026-10-30T00:00:00.000Z' };
}

async function run(version: DatasetVersionRecord, s: WorkspaceSpecRecord, params: Record<string, unknown> = {}) {
  const registered: Array<Record<string, unknown>> = [];
  const resultId = randomUUID();
  const deps: Omit<AnalyticsJobDeps, 'store'> = {
    loadVersion: async () => version,
    loadWorkspaceSpec: async () => s,
    registerResult: async (input) => {
      registered.push(input as unknown as Record<string, unknown>);
    },
  };
  const outcome = await runAnalyticsJob(
    {
      jobId: randomUUID(),
      workspaceId: WORKSPACE,
      payload: { datasetVersionId: version.id, querySpec: s.specId, params, resultId },
    },
    { store: STORE, ...deps }
  );
  return { outcome, registered, resultId };
}

describe('workspace spec parameters', () => {
  it('parses spec ids and declarations', () => {
    expect(parseWorkspaceSpecId('ws:transit-error@3')).toEqual({ slug: 'transit-error', version: 3 });
    expect(parseWorkspaceSpecId('job-failures-by-type-month@1')).toBeNull();
    expect(parseWorkspaceSpecId('ws:Bad@1')).toBeNull();
    expect(validateParamDecls([{ name: 'since', type: 'date' }])).toBeNull();
    expect(validateParamDecls([{ name: 'Since', type: 'date' }])).not.toBeNull();
    expect(validateParamDecls([{ name: 'a', type: 'blob' }])).not.toBeNull();
  });

  it('requires every declared param and rejects wrong types and extras', () => {
    const declared: SpecParam[] = [{ name: 'since', type: 'date' }, { name: 'min', type: 'integer' }];
    expect(coerceParams(declared, { since: '2026-01-01', min: 2 })).toEqual({
      ok: true,
      values: { since: '2026-01-01', min: 2 },
    });
    expect(coerceParams(declared, { since: '2026-01-01' }).ok).toBe(false);
    expect(coerceParams(declared, { since: 'yesterday', min: 2 }).ok).toBe(false);
    expect(coerceParams(declared, { since: '2026-01-01', min: 2, extra: 1 }).ok).toBe(false);
  });
});

describe('validateWorkspaceSql', () => {
  const base = { params: [] as SpecParam[], schema: SCHEMA };

  it('accepts one SELECT over data with matching params', async () => {
    expect(
      await validateWorkspaceSql({
        sql: 'SELECT job_type, count(*) AS n FROM data WHERE created_at >= CAST($since AS TIMESTAMP) GROUP BY 1',
        params: [{ name: 'since', type: 'date' }],
        schema: SCHEMA,
      })
    ).toBeNull();
  });

  it('rejects more than one statement, non-SELECT, and param mismatches', async () => {
    expect(await validateWorkspaceSql({ ...base, sql: 'SELECT 1; SELECT 2' })).toMatch(/exactly one/);
    expect(await validateWorkspaceSql({ ...base, sql: 'DROP TABLE data' })).toMatch(/SELECT/);
    expect(await validateWorkspaceSql({ ...base, sql: 'SELECT $x AS x' })).toMatch(/not declared/);
    expect(
      await validateWorkspaceSql({ ...base, sql: 'SELECT 1', params: [{ name: 'x', type: 'text' }] })
    ).toMatch(/never uses/);
  });

  it('rejects SQL that reaches outside the dataset', async () => {
    const other = tempPath('other.parquet');
    fs.writeFileSync(other, await parquetBytes(ROWS));
    expect(await validateWorkspaceSql({ ...base, sql: `SELECT * FROM read_parquet('${other}')` })).not.toBeNull();
    expect(await validateWorkspaceSql({ ...base, sql: "SELECT * FROM read_csv('/etc/passwd')" })).not.toBeNull();
  });
});

describe('workspace spec job', () => {
  it('runs a parameterised spec over its own dataset and registers the result', async () => {
    const version = await seedVersion();
    const s = spec(
      "SELECT job_type, count(*)::BIGINT AS n FROM data WHERE created_at >= CAST($since AS TIMESTAMP) GROUP BY 1 ORDER BY 1",
      [{ name: 'since', type: 'date' }]
    );
    const { outcome, registered, resultId } = await run(version, s, { since: '2026-02-01' });
    if (!outcome.ok) throw new Error(outcome.summary);

    const bytes = await STORE.get(`workspaces/${WORKSPACE}/lake/_results/${resultId}.parquet`);
    expect((await readParquetRows(bytes!)).rows).toEqual([
      { job_type: 'archive_file', n: 1 },
      { job_type: 'thumbnail', n: 1 },
    ]);
    expect(registered[0]!['querySpec']).toBe('ws:q@1');
  });

  it('cannot read another tenant file or open the network, even if a bad spec is stored', async () => {
    const version = await seedVersion();
    const otherWorkspace = randomUUID();
    const foreignKey = `workspaces/${otherWorkspace}/lake/secret/v1/dt=2026-03-04/part-x.parquet`;
    await STORE.put(foreignKey, await parquetBytes(ROWS), 'application/vnd.apache.parquet');
    const foreignFile = path.join(ROOT, foreignKey);

    for (const sql of [
      `SELECT * FROM read_parquet('${foreignFile}')`,
      `SELECT * FROM read_parquet('${path.join(ROOT, 'workspaces', otherWorkspace, '**', '*.parquet')}')`,
      "SELECT * FROM read_parquet('https://example.com/x.parquet')",
    ]) {
      const { outcome, registered } = await run(version, spec(sql));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('SPEC_ERROR');
      expect(registered).toHaveLength(0);
    }
  });

  it('fails closed on a missing spec and on bad params', async () => {
    const version = await seedVersion();
    const missing = await runAnalyticsJob(
      { jobId: randomUUID(), workspaceId: WORKSPACE, payload: { datasetVersionId: version.id, querySpec: 'ws:nope@1', resultId: randomUUID() } },
      { store: STORE, loadVersion: async () => version, loadWorkspaceSpec: async () => null, registerResult: async () => {} }
    );
    expect(missing).toMatchObject({ ok: false, code: 'SPEC_NOT_FOUND' });

    const s = spec('SELECT $n AS n', [{ name: 'n', type: 'integer' }]);
    const bad = await run(version, s, { n: 'x' });
    expect(bad.outcome).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
  });
});
