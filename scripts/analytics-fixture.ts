/**
 * Shared fixture for the analytics verification and production smoke scripts.
 *
 * The rows are fixed so the expected aggregate is independent of the database:
 * the differential eval compares DuckDB's answer over these Parquet parts with
 * PostgreSQL's answer over the same rows, and the smoke asserts the known
 * numbers. `job-failures-by-type-month@1` must yield:
 *
 *   archive_file  2026-01-01  2
 *   thumbnail     2026-01-01  1
 *   thumbnail     2026-02-01  2
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';

export interface FixtureRow {
  job_type: string;
  state: string;
  /** A UTC instant in naive form, e.g. `2026-01-31 23:59:59`. */
  created_at: string;
}

/** The declared schema the fixture parts are written with. */
export const FIXTURE_SCHEMA = [
  { name: 'job_type', type: 'TEXT' },
  { name: 'state', type: 'TEXT' },
  { name: 'created_at', type: 'TIMESTAMP' },
];

export const FIXTURE_ROWS: FixtureRow[] = [
  { job_type: 'archive_file', state: 'failed', created_at: '2026-01-02 00:00:00' },
  { job_type: 'archive_file', state: 'failed', created_at: '2026-01-31 23:59:59' },
  { job_type: 'archive_file', state: 'completed', created_at: '2026-01-15 12:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-01-20 08:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-02-01 00:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-02-28 23:59:59' },
  { job_type: 'thumbnail', state: 'running', created_at: '2026-02-28 10:00:00' },
];

/** The fixture split across two parts, one per month. */
export const FIXTURE_PARTS: Array<{ partition: string; rows: FixtureRow[] }> = [
  { partition: '2026-01-31', rows: FIXTURE_ROWS.filter((row) => row.created_at.startsWith('2026-01')) },
  { partition: '2026-02-28', rows: FIXTURE_ROWS.filter((row) => row.created_at.startsWith('2026-02')) },
];

/** The independently computed aggregate over `FIXTURE_ROWS`. */
export const EXPECTED_AGGREGATE = [
  { job_type: 'archive_file', month: '2026-01-01', failure_count: 2 },
  { job_type: 'thumbnail', month: '2026-01-01', failure_count: 1 },
  { job_type: 'thumbnail', month: '2026-02-01', failure_count: 2 },
];

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Writes one part to Parquet with the pinned engine and returns the bytes. */
export async function parquetBytes(rows: FixtureRow[]): Promise<Buffer> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const out = path.join(os.tmpdir(), `octo-analytics-fixture-${randomUUID()}.parquet`);
  try {
    await connection.run(
      'CREATE TABLE t (job_type VARCHAR, state VARCHAR, created_at TIMESTAMP)'
    );
    for (const row of rows) {
      await connection.run(
        `INSERT INTO t VALUES (${literal(row.job_type)}, ${literal(row.state)}, TIMESTAMP ${literal(row.created_at)})`
      );
    }
    await connection.run(`COPY t TO ${literal(out)} (FORMAT PARQUET)`);
    return fs.readFileSync(out);
  } finally {
    try {
      connection.closeSync();
    } catch {
      // ignore
    }
    try {
      instance.closeSync();
    } catch {
      // ignore
    }
    fs.rmSync(out, { force: true });
  }
}

/** Reads a result Parquet back as normalized rows, in the canonical order. */
export async function readResultRows(
  bytes: Buffer
): Promise<Array<{ job_type: string; month: string; failure_count: number }>> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const file = path.join(os.tmpdir(), `octo-analytics-result-${randomUUID()}.parquet`);
  try {
    fs.writeFileSync(file, bytes);
    const rows = await (
      await connection.run(
        `SELECT job_type, month::DATE::VARCHAR AS month, failure_count
         FROM read_parquet(${literal(file)})
         ORDER BY job_type, month`
      )
    ).getRowObjects();
    return rows.map((row) => ({
      job_type: String(row['job_type']),
      month: String(row['month']),
      failure_count: Number(row['failure_count']),
    }));
  } finally {
    try {
      connection.closeSync();
    } catch {
      // ignore
    }
    try {
      instance.closeSync();
    } catch {
      // ignore
    }
    fs.rmSync(file, { force: true });
  }
}

/** The registration body the verification and smoke scripts submit. */
export async function fixtureRegistrationBody(dataset: string): Promise<{
  dataset: string;
  name: string;
  format: 'parquet';
  schema: typeof FIXTURE_SCHEMA;
  provenance: { source: string; exportedAt: string };
  watermark: string;
  parts: Array<{ partition: string; dataBase64: string }>;
}> {
  const parts: Array<{ partition: string; dataBase64: string }> = [];
  for (const part of FIXTURE_PARTS) {
    parts.push({ partition: part.partition, dataBase64: (await parquetBytes(part.rows)).toString('base64') });
  }
  return {
    dataset,
    name: 'Analytics verification fixture',
    format: 'parquet',
    schema: FIXTURE_SCHEMA,
    provenance: { source: 'octo.jobs', exportedAt: new Date().toISOString() },
    watermark: '2026-02-28T23:59:59Z',
    parts,
  };
}
