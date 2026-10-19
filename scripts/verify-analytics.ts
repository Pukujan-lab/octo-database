/**
 * Live analytics verification (productization Slice 7).
 *
 * Proves the accepted job against a real PostgreSQL catalog and the real DuckDB
 * engine, with the object store swapped for the local backend (the bytes path is
 * the same `ObjectStore` contract production uses over R2):
 *
 *   1. the pinned DuckDB build loads and reports a version;
 *   2. a registration inspects the Parquet footers, assigns a version, and
 *      records the server-derived keys;
 *   3. the analytics_query job answers `job-failures-by-type-month@1`;
 *   4. DuckDB's answer equals PostgreSQL's answer over the same rows (the
 *      differential oracle);
 *   5. re-running the same immutable version reproduces the same logical rows;
 *   6. a corrupt part fails the job with a stable code, never a hang or an empty
 *      result;
 *   7. a dataset version is invisible to another workspace.
 *
 * Env:
 *   DATABASE_URL  the Octo database (service-pool writes fall back to it).
 *
 * Exit code 0 = all checks passed; 1 = a check failed; 2 = misconfigured.
 */

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pg from 'pg';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('verify-analytics: DATABASE_URL is required');
  process.exit(2);
}
// Both pool URLs are read at import time; point the trusted pool at the same
// database when a dedicated service role is not configured.
process.env['OCTO_SERVICE_URL'] = process.env['OCTO_SERVICE_URL'] || databaseUrl;

const { registerDatasetVersion } = await import('../src/analytics/registration');
const { runAnalyticsJob } = await import('../src/analytics/job');
const { analyticsEngineStatus, readParquetRows } = await import('../src/analytics/engine');
const { resultObjectKey } = await import('../src/analytics/paths');
const {
  dbEnqueueJob,
  dbRegisterDatasetVersion,
  dbGetDatasetVersion,
  dbRegisterAnalyticsResult,
  dbGetAnalyticsResult,
  dbListAnalyticsRuns,
  dbListDatasets,
} = await import('../src/server/db');
const { LocalObjectStore } = await import('../src/storage/object-store');
const {
  EXPECTED_AGGREGATE,
  FIXTURE_ROWS,
  fixtureRegistrationBody,
  readResultRows,
} = await import('./analytics-fixture');

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const SPEC = 'job-failures-by-type-month@1';
const storeRoot = path.join(os.tmpdir(), `octo-verify-analytics-${randomUUID()}`);
const store = new LocalObjectStore(storeRoot);
const db = new pg.Client({ connectionString: databaseUrl });

let principalId: string | null = null;
let workspaceId: string | null = null;

async function seedWorkspace(): Promise<void> {
  const principal = await db.query<{ id: string }>(
    `INSERT INTO octo.principals (auth_user_id, email, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [randomUUID(), `verify-analytics-${randomUUID()}@octo.invalid`, 'verify-analytics']
  );
  principalId = principal.rows[0]!.id;

  const workspace = await db.query<{ id: string }>(
    `INSERT INTO octo.workspaces (slug, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [`verify-analytics-${randomUUID()}`, 'verify-analytics', principalId]
  );
  workspaceId = workspace.rows[0]!.id;
}

async function seedJobs(): Promise<void> {
  for (const row of FIXTURE_ROWS) {
    await db.query(
      `INSERT INTO octo.jobs (workspace_id, job_type, state, idempotency_key, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, row.job_type, row.state, `fixture:${randomUUID()}`, `${row.created_at}+00`, principalId]
    );
  }
}

async function postgresOracle(): Promise<Array<{ job_type: string; month: string; failure_count: number }>> {
  const result = await db.query<{ job_type: string; month: string; failure_count: string }>(
    `SELECT job_type,
            to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month,
            count(*)::int AS failure_count
     FROM octo.jobs
     WHERE workspace_id = $1 AND state = 'failed'
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    job_type: row.job_type,
    month: row.month,
    failure_count: Number(row.failure_count),
  }));
}

async function runQuery(datasetVersionId: string): Promise<{
  ok: boolean;
  summary: string;
  jobId: string;
  resultId: string;
  rows: Array<{ job_type: string; month: string; failure_count: number }>;
  contentHash: string | null;
  engineVersion: string | null;
}> {
  const resultId = randomUUID();
  const queued = await dbEnqueueJob(
    randomUUID(),
    workspaceId!,
    'analytics_query',
    `verify-analytics:${randomUUID()}`,
    { datasetVersionId, querySpec: SPEC, resultId },
    principalId
  );
  const jobId = queued.job.id;
  const outcome = await runAnalyticsJob(
    {
      jobId,
      workspaceId: workspaceId!,
      payload: { datasetVersionId, querySpec: SPEC, resultId },
    },
    {
      store,
      loadVersion: dbGetDatasetVersion,
      registerResult: async (input) => {
        await dbRegisterAnalyticsResult(input);
      },
    }
  );

  if (!outcome.ok) {
    await db.query(
      `UPDATE octo.jobs SET state = 'failed', error_code = $2, error_summary = $3, completed_at = now() WHERE id = $1`,
      [jobId, outcome.code, outcome.summary]
    );
    return { ok: false, summary: `${outcome.code}: ${outcome.summary}`, jobId, resultId, rows: [], contentHash: null, engineVersion: null };
  }

  // The worker owns the state transition; this harness runs the job directly.
  await db.query(
    `UPDATE octo.jobs SET state = 'completed', completed_at = now() WHERE id = $1`,
    [jobId]
  );

  const key = resultObjectKey(workspaceId!, resultId);
  const bytes = await store.get(key);
  const record = await dbGetAnalyticsResult(workspaceId!, resultId);
  return {
    ok: Boolean(bytes && record),
    summary: outcome.detail,
    jobId,
    resultId,
    rows: bytes ? await readResultRows(bytes) : [],
    contentHash: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    engineVersion: record?.engineVersion ?? null,
  };
}

async function main(): Promise<void> {
  await db.connect();

  try {
    console.log('the pinned engine loads');
    const engine = await analyticsEngineStatus();
    check('DuckDB is configured', engine.configured);
    check('the engine reports a version', Boolean(engine.version), String(engine.version));

    console.log('seed a workspace and the differential fixture');
    await seedWorkspace();
    await seedJobs();

    console.log('register an immutable dataset version');
    const outcome = await registerDatasetVersion(
      {
        workspaceId: workspaceId!,
        createdBy: principalId!,
        body: await fixtureRegistrationBody('verify-job-history'),
        store,
      },
      { createVersion: dbRegisterDatasetVersion }
    );
    check('registration succeeds', outcome.ok, outcome.ok ? '' : outcome.message);
    if (!outcome.ok) throw new Error(outcome.message);
    check('registration created a new version', outcome.created);
    check('the version records the summed row count', outcome.version.rowCount === FIXTURE_ROWS.length, `rowCount=${outcome.version.rowCount}`);
    check('the version records one key per part', outcome.version.objectKeys.length === 2);
    check(
      'every key is under the authenticated workspace',
      outcome.version.objectKeys.every((key) => key.startsWith(`workspaces/${workspaceId}/lake/verify-job-history/v1/`))
    );

    const version = await dbGetDatasetVersion(workspaceId!, outcome.version.id);
    check('the catalog reads the version back', version?.id === outcome.version.id);

    console.log('run the accepted query');
    const first = await runQuery(outcome.version.id);
    check('the analytics job completes', first.ok, first.summary);
    check('the result carries a content hash', /^[0-9a-f]{64}$/.test(first.contentHash ?? ''));
    check('the result records the engine version', Boolean(first.engineVersion), String(first.engineVersion));

    console.log('differential: DuckDB vs PostgreSQL over the same rows');
    const oracle = await postgresOracle();
    check('DuckDB matches the PostgreSQL aggregate', JSON.stringify(first.rows) === JSON.stringify(oracle), JSON.stringify({ duckdb: first.rows, postgres: oracle }));
    check('the fixture aggregate is the known one', JSON.stringify(first.rows) === JSON.stringify(EXPECTED_AGGREGATE), JSON.stringify(first.rows));

    console.log('regenerability: a second run reproduces the same rows');
    const second = await runQuery(outcome.version.id);
    check('the second run completes', second.ok, second.summary);
    check('the second run returns the same logical rows', JSON.stringify(second.rows) === JSON.stringify(first.rows));

    console.log('the dashboard read path returns the same rows');
    const resultBytes = await store.get(resultObjectKey(workspaceId!, first.resultId!));
    check('the result artifact is readable from the store', resultBytes !== null);
    if (resultBytes) {
      const read = await readParquetRows(resultBytes);
      check('the dashboard columns are the spec output', JSON.stringify(read.columns) === JSON.stringify(['job_type', 'month', 'failure_count']));
      // The artifact stores the month bucket as a TIMESTAMP at midnight; the
      // dashboard compares it as the logical date.
      const readRows = read.rows.map((row) => ({
        job_type: String(row['job_type']),
        month: String(row['month']).slice(0, 10),
        failure_count: Number(row['failure_count']),
      }));
      check('the dashboard rows match the aggregate', JSON.stringify(readRows) === JSON.stringify(EXPECTED_AGGREGATE), JSON.stringify(readRows));
      check('the dashboard read is complete', read.rowCount === EXPECTED_AGGREGATE.length && !read.truncated);
    }

    console.log('the dashboard catalog lists the dataset and its runs');
    const datasets = await dbListDatasets(workspaceId!);
    const listed = datasets.find((dataset) => dataset.dataset === 'verify-job-history');
    check('the dataset is listed', Boolean(listed));
    check('the listing points at the registered version', listed?.latestVersionId === outcome.version.id);
    check('the listing reports both parts', listed?.partCount === 2, `partCount=${listed?.partCount}`);
    check('the listing reports the fixture row count', listed?.rowCount === FIXTURE_ROWS.length, `rowCount=${listed?.rowCount}`);

    const runs = await dbListAnalyticsRuns(workspaceId!);
    const completed = runs.find((run) => run.jobId === first.jobId);
    check('the run is listed', Boolean(completed));
    check('the run records its state', completed?.state === 'completed', String(completed?.state));
    check('the run points at its result', completed?.resultId === first.resultId);
    check('the run reports its row count', completed?.rowCount === EXPECTED_AGGREGATE.length, `rowCount=${completed?.rowCount}`);

    console.log('a corrupt part fails the job deterministically');
    const corruptRegistration = await registerDatasetVersion(
      {
        workspaceId: workspaceId!,
        createdBy: principalId!,
        body: await fixtureRegistrationBody('verify-corrupt'),
        store,
      },
      { createVersion: dbRegisterDatasetVersion }
    );
    check('the corrupt fixture registers', corruptRegistration.ok, corruptRegistration.ok ? '' : corruptRegistration.message);
    if (corruptRegistration.ok) {
      // Replace one immutable part with bytes that are not Parquet; the job must
      // report a stable code instead of hanging or returning an empty result.
      await store.put(
        corruptRegistration.version.objectKeys[0]!,
        Buffer.from('this is not a parquet file'),
        'application/octet-stream'
      );
      const corrupt = await runQuery(corruptRegistration.version.id);
      check('a corrupt part fails with PARQUET_CORRUPT', !corrupt.ok && corrupt.summary.startsWith('PARQUET_CORRUPT'), corrupt.summary);
    }

    console.log('isolation: another workspace cannot see the version');
    const stranger = await dbGetDatasetVersion(randomUUID(), outcome.version.id);
    check('the version is invisible outside its workspace', stranger === null);
  } finally {
    if (workspaceId) {
      await db.query('DELETE FROM octo.workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
    }
    if (principalId) {
      await db.query('DELETE FROM octo.principals WHERE id = $1', [principalId]).catch(() => undefined);
    }
    await db.end().catch(() => undefined);
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\nverify-analytics: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nverify-analytics: all checks passed');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
