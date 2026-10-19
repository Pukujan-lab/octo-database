/**
 * Metamorphic evals for Slice 7 analytics (MR-A, MR-B).
 *
 * These assert invariants that must hold for any correct implementation, not a
 * fixed expected answer:
 *
 *   MR-A  the same logical rows produce the same logical result regardless of
 *         how they are partitioned across Parquet files.
 *   MR-B  the derivation is deterministic: re-running the named spec over the
 *         same immutable files reproduces the same logical rows and engine
 *         version.
 */

import { describe, expect, it } from 'vitest';
import { getQuerySpec } from '../../src/analytics/specs';
import { runSpecOverParquetFiles } from '../../src/analytics/engine';
import { parquetBytes, readResultRows, tempPath, JobRow } from './analytics-test-helpers';

const ROWS: JobRow[] = [
  { job_type: 'archive_file', state: 'failed', created_at: '2025-12-31 23:59:59' },
  { job_type: 'archive_file', state: 'failed', created_at: '2026-01-01 00:00:00' },
  { job_type: 'archive_file', state: 'completed', created_at: '2026-01-15 12:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-01-31 23:59:59' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-02-01 00:00:00' },
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-02-28 08:30:00' },
  { job_type: 'graph_rebuild', state: 'failed', created_at: '2026-02-28 09:00:00' },
  { job_type: 'graph_rebuild', state: 'running', created_at: '2026-02-28 10:00:00' },
];

async function writeParts(rowsByPart: JobRow[][]): Promise<string[]> {
  const files: string[] = [];
  for (const rows of rowsByPart) {
    const file = tempPath(`part-${files.length}.parquet`);
    const fs = await import('fs');
    const path = await import('path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await parquetBytes(rows));
    files.push(file);
  }
  return files;
}

async function runOver(rowsByPart: JobRow[][]): Promise<Array<Record<string, unknown>>> {
  const files = await writeParts(rowsByPart);
  const spec = getQuerySpec('job-failures-by-type-month@1')!;
  const outFile = tempPath('result.parquet');
  const run = await runSpecOverParquetFiles({
    spec,
    files,
    outFile,
    spillDir: tempPath('spill'),
  });
  expect(run.ok).toBe(true);
  if (!run.ok) throw new Error(run.summary);
  return readResultRows(run.bytes);
}

describe('analytics metamorphic invariants', () => {
  it('MR-A: repartitioning the same rows does not change the result', async () => {
    const single = await runOver([ROWS]);
    const byDay = await runOver([
      [ROWS[0]!, ROWS[1]!],
      [ROWS[2]!, ROWS[3]!],
      [ROWS[4]!, ROWS[5]!],
      [ROWS[6]!, ROWS[7]!],
    ]);
    const byMonth = await runOver([
      ROWS.slice(0, 4),
      ROWS.slice(4),
    ]);

    expect(byDay).toEqual(single);
    expect(byMonth).toEqual(single);

    // The expected aggregate is still the independently computed one, so a
    // degenerate "always return nothing" implementation cannot pass by symmetry.
    expect(single).toEqual([
      { job_type: 'archive_file', month: '2025-12-01', failure_count: 1 },
      { job_type: 'archive_file', month: '2026-01-01', failure_count: 1 },
      { job_type: 'graph_rebuild', month: '2026-02-01', failure_count: 1 },
      { job_type: 'thumbnail', month: '2026-01-01', failure_count: 1 },
      { job_type: 'thumbnail', month: '2026-02-01', failure_count: 2 },
    ]);
  });

  it('MR-B: re-running the same immutable files reproduces the same result', async () => {
    const files = await writeParts([ROWS.slice(0, 4), ROWS.slice(4)]);
    const spec = getQuerySpec('job-failures-by-type-month@1')!;

    const first = await runSpecOverParquetFiles({
      spec,
      files,
      outFile: tempPath('first.parquet'),
      spillDir: tempPath('spill'),
    });
    const second = await runSpecOverParquetFiles({
      spec,
      files,
      outFile: tempPath('second.parquet'),
      spillDir: tempPath('spill'),
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('run failed');

    expect(await readResultRows(second.bytes)).toEqual(await readResultRows(first.bytes));
    expect(second.rowCount).toBe(first.rowCount);
    expect(second.engineVersion).toBe(first.engineVersion);
  });
});
