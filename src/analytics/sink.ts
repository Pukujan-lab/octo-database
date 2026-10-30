/**
 * The write-back half of a scheduled analytics run: turns a result's rows into
 * the statements that land them in `analytics.<table>` in the workspace database.
 *
 * Pure SQL construction only. Identifiers are validated and quoted here; values
 * always travel as bind parameters. The server runs the statements as the
 * workspace's own role (src/server/analytics-sink.ts).
 */

import { typeFamily } from './specs';
import type { AnalyticsSink } from '../types/analytics';

export const SINK_SCHEMA = 'analytics';
const IDENT = /^[a-z][a-z0-9_]{0,50}$/;
const ROWS_PER_INSERT = 500;

/** Structural validation of a sink declaration against the result columns. */
export function validateSink(raw: unknown): { ok: true; sink: AnalyticsSink } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'sink must be an object' };
  const { table, mode, keys } = raw as { table?: unknown; mode?: unknown; keys?: unknown };
  if (typeof table !== 'string' || !IDENT.test(table)) {
    return { ok: false, message: 'sink.table must match [a-z][a-z0-9_]*' };
  }
  if (mode !== 'replace' && mode !== 'upsert') return { ok: false, message: 'sink.mode must be replace or upsert' };
  const keyList = keys === undefined ? [] : keys;
  if (!Array.isArray(keyList) || keyList.some((key) => typeof key !== 'string' || !IDENT.test(key))) {
    return { ok: false, message: 'sink.keys must be column names matching [a-z][a-z0-9_]*' };
  }
  if (mode === 'upsert' && keyList.length === 0) return { ok: false, message: 'sink.keys is required for upsert' };
  return { ok: true, sink: { table, mode, keys: keyList as string[] } };
}

/** The Postgres column type for a DuckDB result column. */
export function pgType(duckType: string): string {
  switch (typeFamily(duckType)) {
    case 'integer':
      return 'bigint';
    case 'double':
      return /^DECIMAL/i.test(duckType) ? 'numeric' : 'double precision';
    case 'boolean':
      return 'boolean';
    case 'timestamp':
      return 'timestamp';
    case 'date':
      return 'date';
    default:
      return 'text';
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface SinkStatement {
  text: string;
  values?: unknown[];
}

/**
 * The statements for one run, to execute in a single transaction. Throws when a
 * column name or a key is not usable, so a bad declaration fails the job rather
 * than writing a partial table.
 */
export function buildSinkStatements(input: {
  sink: AnalyticsSink;
  columns: string[];
  columnTypes: string[];
  rows: Array<Record<string, unknown>>;
}): SinkStatement[] {
  const { sink, columns, columnTypes, rows } = input;
  for (const name of columns) {
    if (!IDENT.test(name)) throw new Error(`result column ${name} is not a valid table column name`);
  }
  for (const key of sink.keys) {
    if (!columns.includes(key)) throw new Error(`sink key ${key} is not a result column`);
  }

  const table = `${quote(SINK_SCHEMA)}.${quote(sink.table)}`;
  const definitions = columns.map((name, index) => `${quote(name)} ${pgType(columnTypes[index]!)}`);
  if (sink.mode === 'upsert') definitions.push(`PRIMARY KEY (${sink.keys.map(quote).join(', ')})`);

  const statements: SinkStatement[] = [
    { text: `CREATE SCHEMA IF NOT EXISTS ${quote(SINK_SCHEMA)}` },
    { text: `CREATE TABLE IF NOT EXISTS ${table} (${definitions.join(', ')})` },
  ];
  if (sink.mode === 'replace') statements.push({ text: `DELETE FROM ${table}` });

  const columnList = columns.map(quote).join(', ');
  const update = columns.filter((name) => !sink.keys.includes(name));
  const conflict =
    sink.mode === 'upsert'
      ? ` ON CONFLICT (${sink.keys.map(quote).join(', ')}) ` +
        (update.length > 0
          ? `DO UPDATE SET ${update.map((name) => `${quote(name)} = EXCLUDED.${quote(name)}`).join(', ')}`
          : 'DO NOTHING')
      : '';

  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    const chunk = rows.slice(start, start + ROWS_PER_INSERT);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((name) => {
        values.push(row[name] ?? null);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    statements.push({
      text: `INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(', ')}${conflict}`,
      values,
    });
  }
  return statements;
}
