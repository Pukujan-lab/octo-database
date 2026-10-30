/**
 * Writes a scheduled analytics result into the workspace's own database.
 *
 * Connects as the workspace's NOSUPERUSER role (the same boundary as the Slice 21
 * SQL surface), never as the provisioning credential, and runs the whole write
 * in one transaction so a failed run leaves the previous table contents intact.
 */

import pg from 'pg';
import { readParquetRows } from '../analytics/engine';
import { buildSinkStatements } from '../analytics/sink';
import { decryptSecret } from '../lib/mfa';
import type { AnalyticsSink } from '../types/analytics';
import { dbGetWorkspaceDatabase, dbGetWorkspaceDatabaseCredential } from './db';
import { buildInternalConnectionString } from './provisioning';

const { Client } = pg;

/** Most rows a scheduled run may write in one pass. */
export const SINK_MAX_ROWS = 100_000;

export async function writeAnalyticsSink(input: {
  workspaceId: string;
  sink: AnalyticsSink;
  resultBytes: Buffer;
}): Promise<{ rowsWritten: number }> {
  const database = await dbGetWorkspaceDatabase(input.workspaceId);
  if (!database) throw new Error('DATABASE_NOT_PROVISIONED: provision a database for this workspace first');
  const stored = await dbGetWorkspaceDatabaseCredential(input.workspaceId);
  if (!stored) throw new Error('DATABASE_CREDENTIAL_MISSING: run a workspace query once to store the credential');

  const result = await readParquetRows(input.resultBytes, SINK_MAX_ROWS, SINK_MAX_ROWS);
  if (result.truncated) throw new Error(`result has ${result.rowCount} rows; a sink writes at most ${SINK_MAX_ROWS}`);

  const statements = buildSinkStatements({
    sink: input.sink,
    columns: result.columns,
    columnTypes: result.columnTypes,
    rows: result.rows,
  });

  const client = new Client({
    connectionString: buildInternalConnectionString(database.roleName, decryptSecret(stored), database.dbName),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) await client.query(statement.text, statement.values);
    await client.query('COMMIT');
    return { rowsWritten: result.rows.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}
