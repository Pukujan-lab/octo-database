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
import { QuerySpec, sqlLiteral, typeFamily } from './specs';
import type { AnalyticsRows, ColumnSpec, SpecParam } from '../types/analytics';

/** Most rows the dashboard's result read returns in one response. */
export const ANALYTICS_ROWS_LIMIT = 500;

/**
 * Reads a result artifact back as JSON rows. DuckDB's JSON row reader turns every
 * value into a JSON primitive (dates, timestamps, and decimals as strings), and
 * numeric columns are converted back to numbers so the dashboard can total them.
 */
export async function readParquetRows(
  bytes: Buffer,
  limit = ANALYTICS_ROWS_LIMIT,
  cap = ANALYTICS_ROWS_LIMIT
): Promise<AnalyticsRows> {
  const capped = Math.max(1, Math.min(Math.floor(limit), cap));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-analytics-rows-'));
  const file = path.join(dir, 'result.parquet');
  fs.writeFileSync(file, bytes);

  const { instance, connection } = await openInstance();
  try {
    const described = await (
      await connection.run(`DESCRIBE SELECT * FROM read_parquet(${sqlLiteral(file)})`)
    ).getRowObjects();
    const numeric = new Set(
      described
        .filter((row) => ['integer', 'double'].includes(typeFamily(String(row['column_type']))))
        .map((row) => String(row['column_name']))
    );

    const counted = await (
      await connection.run(`SELECT count(*)::BIGINT AS n FROM read_parquet(${sqlLiteral(file)})`)
    ).getRowObjects();
    const total = Number(counted[0]?.['n'] ?? 0);

    const reader = await connection.runAndReadAll(
      `SELECT * FROM read_parquet(${sqlLiteral(file)}) LIMIT ${capped}`
    );
    const raw = reader.getRowObjectsJson();
    const rows = raw.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(row)) {
        out[name] =
          numeric.has(name) && typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : value;
      }
      return out;
    });

    return {
      columns: described.map((row) => String(row['column_name'])),
      columnTypes: described.map((row) => String(row['column_type'])),
      rows,
      rowCount: total,
      truncated: total > rows.length,
    };
  } finally {
    closeQuietly(instance, connection);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

// Workspace-registered specs -------------------------------------------------------
//
// A workspace writes its own SELECT, so the fence cannot be the SQL text. It is
// the engine: the dataset parts are mounted as the view `data` first, then DuckDB
// is locked so the statement can read nothing else (no other file, no URL, no
// extension, no setting change). The only files on disk are the job's own
// workspace-derived parts, and `allowed_paths` names exactly those plus the output.

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function lockDown(connection: DuckDBConnection, paths: string[], dirs: string[]): Promise<void> {
  if (paths.length > 0) {
    await connection.run(`SET allowed_paths = [${paths.map(sqlLiteral).join(', ')}]`);
  }
  if (dirs.length > 0) {
    await connection.run(`SET allowed_directories = [${dirs.map(sqlLiteral).join(', ')}]`);
  }
  await connection.run('SET enable_external_access = false');
  await connection.run('SET autoinstall_known_extensions = false');
  await connection.run('SET autoload_known_extensions = false');
  await connection.run('SET lock_configuration = true');
}

function paramTypes(
  module: DuckDbModule,
  params: SpecParam[]
): Record<string, import('@duckdb/node-api').DuckDBType> {
  const out: Record<string, import('@duckdb/node-api').DuckDBType> = {};
  for (const param of params) {
    out[param.name] =
      param.type === 'integer'
        ? module.BIGINT
        : param.type === 'double'
          ? module.DOUBLE
          : param.type === 'boolean'
            ? module.BOOLEAN
            : module.VARCHAR;
  }
  return out;
}

const SAMPLE_PARAM: Record<SpecParam['type'], string | number | boolean> = {
  text: '',
  integer: 0,
  double: 0,
  boolean: false,
  date: '2000-01-01',
  timestamp: '2000-01-01 00:00:00',
};

/** Trims whitespace and trailing semicolons so the statement can be wrapped. */
export function normalizeSpecSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').trim();
}

/**
 * Checks a workspace spec before it is stored: one SELECT, parameters that match
 * the declaration, and the statement binds and runs (zero rows) against an empty
 * table shaped like the dataset. Returns an error message or null.
 */
export async function validateWorkspaceSql(input: {
  sql: string;
  params: SpecParam[];
  schema: ColumnSpec[];
}): Promise<string | null> {
  const module = await loadModule();
  if (!module) return 'the DuckDB engine failed to load';
  const { instance, connection } = await openInstance();
  let timer: NodeJS.Timeout | null = null;
  try {
    await connection.run('SET max_memory = ' + sqlLiteral(ANALYTICS_MAX_MEMORY));
    await connection.run(
      `CREATE TABLE data (${input.schema.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(', ')})`
    );
    await lockDown(connection, [], []);

    const extracted = await connection.extractStatements(input.sql);
    if (extracted.count !== 1) return 'a spec must be exactly one SELECT statement';
    const prepared = await extracted.prepare(0);
    if (prepared.statementType !== module.StatementType.SELECT) return 'a spec must be a SELECT statement';

    const used = new Set<string>();
    for (let index = 1; index <= prepared.parameterCount; index += 1) used.add(prepared.parameterName(index));
    const declared = new Set(input.params.map((p) => p.name));
    for (const name of Array.from(used)) if (!declared.has(name)) return `the SQL uses $${name}, which is not declared in params`;
    for (const name of Array.from(declared)) if (!used.has(name)) return `param ${name} is declared but the SQL never uses it`;

    timer = setTimeout(() => {
      try {
        connection.interrupt();
      } catch {
        // ignore
      }
    }, 5000);
    const values: Record<string, string | number | boolean> = {};
    for (const param of input.params) values[param.name] = SAMPLE_PARAM[param.type];
    await connection.run(`SELECT * FROM (\n${input.sql}\n) LIMIT 0`, values, paramTypes(module, input.params));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timer) clearTimeout(timer);
    closeQuietly(instance, connection);
  }
}

/**
 * Runs a workspace spec over the job's Parquet parts (mounted as `data`) and
 * writes the result Parquet to `outFile`.
 */
export async function runWorkspaceSql(input: {
  sql: string;
  params: SpecParam[];
  values: Record<string, string | number | boolean>;
  files: string[];
  outFile: string;
  spillDir: string;
  timeoutMs?: number;
}): Promise<AnalyticsRunResult> {
  const timeoutMs = input.timeoutMs ?? ANALYTICS_QUERY_TIMEOUT_MS;
  fs.mkdirSync(input.spillDir, { recursive: true });
  const module = await loadModule();
  if (!module) return { ok: false, code: 'ANALYTICS_NOT_CONFIGURED', summary: 'the DuckDB engine failed to load', retryable: false };

  const { instance, connection } = await openInstance();
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  try {
    await connection.run(`SET max_memory = ${sqlLiteral(ANALYTICS_MAX_MEMORY)}`);
    await connection.run('SET threads = 2');
    await connection.run(`SET temp_directory = ${sqlLiteral(input.spillDir)}`);
    await connection.run(
      `CREATE VIEW data AS SELECT * FROM read_parquet([${input.files.map(sqlLiteral).join(', ')}])`
    );
    await lockDown(connection, [...input.files, input.outFile], [input.spillDir]);

    timer = setTimeout(() => {
      timedOut = true;
      try {
        connection.interrupt();
      } catch {
        // ignore: the run's rejection carries the outcome
      }
    }, timeoutMs);

    await connection.run(`CREATE TABLE result AS\n${input.sql}`, input.values, paramTypes(module, input.params));
    await connection.run(`COPY result TO ${sqlLiteral(input.outFile)} (FORMAT PARQUET)`);

    const counted = await (await connection.run('SELECT count(*)::BIGINT AS n FROM result')).getRowObjects();
    const versionRows = await (await connection.run('SELECT version() AS version')).getRowObjects();
    const version = versionRows[0]?.['version'];
    return {
      ok: true,
      bytes: fs.readFileSync(input.outFile),
      rowCount: Number(counted[0]?.['n'] ?? 0),
      engineVersion: typeof version === 'string' ? version : String(version ?? 'unknown'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) return { ok: false, code: 'QUERY_TIMEOUT', summary: `query exceeded its time limit: ${message}`, retryable: false };
    return { ok: false, code: 'SPEC_ERROR', summary: message, retryable: false };
  } finally {
    if (timer) clearTimeout(timer);
    closeQuietly(instance, connection);
  }
}
