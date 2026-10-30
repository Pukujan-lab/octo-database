/**
 * Named query specs for the analytics lake (Slice 7).
 *
 * The caller submits a spec id, never SQL. The server builds the statement from
 * the spec's registry entry and the object keys of one immutable dataset
 * version, so a request can neither widen the read nor inject SQL.
 */

import type { ColumnSpec, SpecParam, SpecParamType } from '../types/analytics';

export interface QuerySpec {
  id: string;
  /** Columns a dataset must carry for this spec to be answerable. */
  inputColumns: ColumnSpec[];
  /** The result columns, in order. */
  outputColumns: string[];
  buildSql(files: string[]): string;
}

/** A SQL string literal for a server-derived file path. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Collapses the many names the same logical type can carry (DuckDB's
 * `DESCRIBE` output, Parquet physical/logical type names, and the declaration a
 * caller writes) into one family for comparison.
 */
export function typeFamily(type: string): string {
  const upper = type.trim().toUpperCase();
  if (['VARCHAR', 'TEXT', 'STRING', 'CHAR', 'BPCHAR', 'UTF8'].includes(upper)) return 'text';
  if (upper.startsWith('TIMESTAMP') || upper === 'TIMESTAMPTZ' || upper === 'DATETIME') {
    return 'timestamp';
  }
  if (/^(U?INT(8|16|32|64)?|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|INT32|INT64)$/.test(upper)) {
    return 'integer';
  }
  if (/^(DOUBLE|FLOAT|FLOAT4|FLOAT8|REAL|DECIMAL|NUMERIC)/.test(upper)) return 'double';
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'boolean';
  if (upper === 'DATE' || upper === 'DATE32') return 'date';
  if (['BLOB', 'BINARY', 'BYTE_ARRAY', 'BYTES'].includes(upper)) return 'binary';
  return upper.toLowerCase();
}

/** Structural validation of a declared schema. Returns an error message or null. */
export function validateDeclaredSchema(schema: unknown): string | null {
  if (!Array.isArray(schema) || schema.length === 0) {
    return 'schema must be a non-empty array of { name, type }';
  }
  const seen = new Set<string>();
  for (const column of schema) {
    if (!column || typeof column !== 'object') return 'schema entries must be { name, type }';
    const name = (column as { name?: unknown }).name;
    const type = (column as { type?: unknown }).type;
    if (typeof name !== 'string' || !name.trim()) return 'every schema column needs a name';
    if (typeof type !== 'string' || !type.trim()) return `schema column ${name} needs a type`;
    if (seen.has(name)) return `duplicate schema column ${name}`;
    seen.add(name);
  }
  return null;
}

/** True when the declared schema and the Parquet footer describe the same columns. */
export function schemaMatchesDeclared(declared: ColumnSpec[], actual: ColumnSpec[]): boolean {
  if (declared.length !== actual.length) return false;
  return declared.every(
    (column, index) =>
      column.name === actual[index]!.name && typeFamily(column.type) === typeFamily(actual[index]!.type)
  );
}

/** True when a declared schema carries every column the spec needs. */
export function carriesSpecInputs(schema: ColumnSpec[], spec: QuerySpec): boolean {
  return spec.inputColumns.every((required) => {
    const found = schema.find((column) => column.name === required.name);
    return Boolean(found && typeFamily(found.type) === typeFamily(required.type));
  });
}

const JOB_FAILURES_INPUTS: ColumnSpec[] = [
  { name: 'job_type', type: 'TEXT' },
  { name: 'state', type: 'TEXT' },
  { name: 'created_at', type: 'TIMESTAMP' },
];

/**
 * The first accepted question: failed jobs by type and month, over a dataset the
 * caller registered. Month is UTC-truncated on both sides of the differential
 * oracle; the canonical order is part of the result contract.
 */
export const QUERY_SPECS: Record<string, QuerySpec> = {
  'job-failures-by-type-month@1': {
    id: 'job-failures-by-type-month@1',
    inputColumns: JOB_FAILURES_INPUTS,
    outputColumns: ['job_type', 'month', 'failure_count'],
    buildSql(files: string[]): string {
      const list = files.map(sqlLiteral).join(', ');
      // `created_at` is a UTC instant in both accepted physical types. The cast
      // makes the bucket a naive TIMESTAMP, so the artifact's meaning does not
      // depend on the timezone of whoever reads it back.
      return [
        'SELECT job_type,',
        "       date_trunc('month', CAST(created_at AS TIMESTAMP)) AS month,",
        '       count(*)::BIGINT AS failure_count',
        `FROM read_parquet([${list}])`,
        "WHERE state = 'failed'",
        'GROUP BY 1, 2',
        'ORDER BY 1, 2',
      ].join('\n');
    },
  },
};

export function getQuerySpec(id: string): QuerySpec | null {
  return Object.prototype.hasOwnProperty.call(QUERY_SPECS, id) ? QUERY_SPECS[id]! : null;
}

/** The id a workspace spec is submitted under: `ws:<slug>@<version>`. */
const WORKSPACE_SPEC_ID = /^ws:([a-z0-9][a-z0-9-]{0,62})@([1-9]\d{0,8})$/;

export function parseWorkspaceSpecId(id: string): { slug: string; version: number } | null {
  const match = WORKSPACE_SPEC_ID.exec(id);
  return match ? { slug: match[1]!, version: Number(match[2]) } : null;
}

export function workspaceSpecId(slug: string, version: number): string {
  return `ws:${slug}@${version}`;
}

const PARAM_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const PARAM_TYPES: SpecParamType[] = ['text', 'integer', 'double', 'boolean', 'date', 'timestamp'];
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Structural validation of declared spec parameters. Returns an error or null. */
export function validateParamDecls(raw: unknown): string | null {
  if (!Array.isArray(raw)) return 'params must be an array of { name, type }';
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = (entry as { name?: unknown } | null)?.name;
    const type = (entry as { type?: unknown } | null)?.type;
    if (typeof name !== 'string' || !PARAM_NAME.test(name)) {
      return 'param names must match [a-z][a-z0-9_]*';
    }
    if (typeof type !== 'string' || !PARAM_TYPES.includes(type as SpecParamType)) {
      return `param ${name} type must be one of ${PARAM_TYPES.join(', ')}`;
    }
    if (seen.has(name)) return `duplicate param ${name}`;
    seen.add(name);
  }
  return null;
}

/**
 * Checks supplied values against the declared params and returns the values to
 * bind, or an error. Every declared param is required and nothing else is accepted.
 * Dates and timestamps are bound as text; the SQL casts them (`CAST($from AS DATE)`).
 */
export function coerceParams(
  declared: SpecParam[],
  supplied: unknown
): { ok: true; values: Record<string, string | number | boolean> } | { ok: false; message: string } {
  const given = supplied === undefined ? {} : supplied;
  if (!given || typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, message: 'params must be an object' };
  }
  const input = given as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !declared.some((p) => p.name === key));
  if (extra.length > 0) return { ok: false, message: `unknown param ${extra[0]}` };

  const values: Record<string, string | number | boolean> = {};
  for (const param of declared) {
    const value = input[param.name];
    const bad = (): { ok: false; message: string } => ({
      ok: false,
      message: `param ${param.name} must be a ${param.type}`,
    });
    if (value === undefined) return { ok: false, message: `param ${param.name} is required` };
    switch (param.type) {
      case 'text':
        if (typeof value !== 'string' || value.length > 1000) return bad();
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) return bad();
        break;
      case 'double':
        if (typeof value !== 'number' || !Number.isFinite(value)) return bad();
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return bad();
        break;
      case 'date':
        if (typeof value !== 'string' || !DATE_TEXT.test(value)) return bad();
        break;
      case 'timestamp':
        if (typeof value !== 'string' || !TIMESTAMP_TEXT.test(value)) return bad();
        break;
    }
    values[param.name] = value as string | number | boolean;
  }
  return { ok: true, values };
}
