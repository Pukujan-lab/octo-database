/**
 * Unit tests: scheduled-run write-back (sink SQL, and the job hook).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsJobDeps, runAnalyticsJob } from '../../src/analytics/job';
import { buildSinkStatements, pgType, validateSink } from '../../src/analytics/sink';
import { LocalObjectStore } from '../../src/storage/object-store';
import type { DatasetVersionRecord } from '../../src/types/analytics';
import { parquetBytes } from './analytics-test-helpers';

describe('sink declaration', () => {
  it('accepts replace and upsert, and requires keys for upsert', () => {
    expect(validateSink({ table: 'segment_error', mode: 'replace' }).ok).toBe(true);
    expect(validateSink({ table: 'segment_error', mode: 'upsert', keys: ['segment_id'] }).ok).toBe(true);
    expect(validateSink({ table: 'segment_error', mode: 'upsert' }).ok).toBe(false);
    expect(validateSink({ table: 'Bad Name; DROP', mode: 'replace' }).ok).toBe(false);
    expect(validateSink({ table: 'x', mode: 'append' }).ok).toBe(false);
  });

  it('maps DuckDB types to Postgres types', () => {
    expect(pgType('BIGINT')).toBe('bigint');
    expect(pgType('DOUBLE')).toBe('double precision');
    expect(pgType('DECIMAL(18,3)')).toBe('numeric');
    expect(pgType('TIMESTAMP')).toBe('timestamp');
    expect(pgType('VARCHAR')).toBe('text');
  });
});

describe('sink statements', () => {
  const input = {
    columns: ['segment_id', 'hour', 'err'],
    columnTypes: ['VARCHAR', 'BIGINT', 'DOUBLE'],
    rows: [
      { segment_id: 'a', hour: 8, err: 1.5 },
      { segment_id: 'b', hour: 9, err: 2.5 },
    ],
  };

  it('replace: creates the table, clears it, and inserts with bound values', () => {
    const statements = buildSinkStatements({ ...input, sink: { table: 'seg', mode: 'replace', keys: [] } });
    expect(statements.map((s) => s.text.split(' (')[0])).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "analytics"',
      'CREATE TABLE IF NOT EXISTS "analytics"."seg"',
      'DELETE FROM "analytics"."seg"',
      'INSERT INTO "analytics"."seg"',
    ]);
    const insert = statements[3]!;
    expect(insert.values).toEqual(['a', 8, 1.5, 'b', 9, 2.5]);
    expect(insert.text).toContain('VALUES ($1, $2, $3), ($4, $5, $6)');
  });

  it('upsert: keys the table and updates the non-key columns on conflict', () => {
    const statements = buildSinkStatements({ ...input, sink: { table: 'seg', mode: 'upsert', keys: ['segment_id', 'hour'] } });
    expect(statements[1]!.text).toContain('PRIMARY KEY ("segment_id", "hour")');
    expect(statements.some((s) => s.text.startsWith('DELETE'))).toBe(false);
    expect(statements[2]!.text).toContain('ON CONFLICT ("segment_id", "hour") DO UPDATE SET "err" = EXCLUDED."err"');
  });

  it('throws on a key that is not a result column and on a bad column name', () => {
    expect(() => buildSinkStatements({ ...input, sink: { table: 'seg', mode: 'upsert', keys: ['nope'] } })).toThrow(/not a result column/);
    expect(() =>
      buildSinkStatements({ ...input, columns: ['a b', 'hour', 'err'], sink: { table: 'seg', mode: 'replace', keys: [] } })
    ).toThrow(/valid table column/);
  });

  it('splits large results into several inserts', () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({ segment_id: String(i), hour: i, err: 0 }));
    const statements = buildSinkStatements({ ...input, rows, sink: { table: 'seg', mode: 'replace', keys: [] } });
    expect(statements.filter((s) => s.text.startsWith('INSERT'))).toHaveLength(3);
  });
});

describe('analytics job sink hook', () => {
  const ROOT = path.join(os.tmpdir(), `octo-analytics-sink-${randomUUID()}`);
  const STORE = new LocalObjectStore(ROOT);
  const WORKSPACE = randomUUID();
  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  async function version(): Promise<DatasetVersionRecord> {
    const key = `workspaces/${WORKSPACE}/lake/jobs/v1/dt=2026-03-04/part-${randomUUID()}.parquet`;
    await STORE.put(
      key,
      await parquetBytes([{ job_type: 'archive_file', state: 'failed', created_at: '2026-01-02 00:00:00' }]),
      'application/vnd.apache.parquet'
    );
    return {
      id: randomUUID(), datasetId: randomUUID(), dataset: 'jobs', version: 1, format: 'parquet',
      schema: [{ name: 'job_type', type: 'TEXT' }, { name: 'state', type: 'TEXT' }, { name: 'created_at', type: 'TIMESTAMP' }],
      objectKeys: [key], rowCount: 1, provenance: {}, watermark: null, createdAt: '2026-10-30T00:00:00.000Z',
    };
  }

  function run(v: DatasetVersionRecord, sink: unknown, writeSink?: AnalyticsJobDeps['writeSink']) {
    return runAnalyticsJob(
      {
        jobId: randomUUID(),
        workspaceId: WORKSPACE,
        payload: { datasetVersionId: v.id, querySpec: 'job-failures-by-type-month@1', resultId: randomUUID(), sink },
      },
      { store: STORE, loadVersion: async () => v, loadWorkspaceSpec: async () => null, registerResult: async () => {}, writeSink }
    );
  }

  it('hands the result bytes to the sink and reports the rows written', async () => {
    const v = await version();
    const calls: Array<{ workspaceId: string; table: string; bytes: number }> = [];
    const outcome = await run(v, { table: 'failures', mode: 'replace' }, async (input) => {
      calls.push({ workspaceId: input.workspaceId, table: input.sink.table, bytes: input.resultBytes.length });
      return { rowsWritten: 1 };
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ workspaceId: WORKSPACE, table: 'failures' });
    expect(calls[0]!.bytes).toBeGreaterThan(0);
  });

  it('fails the job when the sink fails, and when none is wired', async () => {
    const v = await version();
    const failed = await run(v, { table: 'failures', mode: 'replace' }, async () => {
      throw new Error('boom');
    });
    expect(failed).toMatchObject({ ok: false, code: 'SINK_ERROR' });
    expect(await run(v, { table: 'failures', mode: 'replace' })).toMatchObject({ ok: false, code: 'SINK_NOT_CONFIGURED' });
    expect(await run(v, { table: 'Bad;', mode: 'replace' }, async () => ({ rowsWritten: 0 }))).toMatchObject({
      ok: false,
      code: 'INVALID_PAYLOAD',
    });
  });
});
