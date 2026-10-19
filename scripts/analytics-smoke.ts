/**
 * Live production smoke for the analytics lake (Slice 7, W1).
 *
 * Proves the deployed instance can actually run the accepted flow -- the pinned
 * DuckDB build loads in the production image, the R2-backed object store accepts
 * the Parquet bytes, and the worker drains an analytics_query job. Everything is
 * driven over HTTP exactly as an adopter would:
 *
 *   1. /health reports the analytics engine as configured;
 *   2. a fresh guest workspace is created and armed for the confirmation gate;
 *   3. the fixture Parquet parts register as an immutable version;
 *   4. the named query is submitted and one queue pass is drained;
 *   5. the job completes and the derived artifact downloads with the known
 *      aggregate and a matching content hash;
 *   6. the smoke workspace is deleted (test-data hygiene).
 *
 * Env:
 *   OCTO_SMOKE_BASE_URL  default https://octodb.design-bakery.com
 *
 * Exit code 0 = all checks passed; 1 = a check failed.
 */

import { createHash, randomUUID } from 'crypto';
import {
  EXPECTED_AGGREGATE,
  FIXTURE_ROWS,
  fixtureRegistrationBody,
  readResultRows,
} from './analytics-fixture';

const baseUrl = (process.env['OCTO_SMOKE_BASE_URL'] ?? 'https://octodb.design-bakery.com').replace(/\/$/, '');
const SPEC = 'job-failures-by-type-month@1';

interface GuestSession {
  workspace: { id: string; slug: string; role: string };
  sessionToken: string;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  console.log(`analytics smoke against ${baseUrl}`);

  console.log('health');
  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await json<{
    status?: string;
    database?: { connected?: boolean };
    r2?: { connected?: boolean };
    analytics?: { configured?: boolean; version?: string | null };
  }>(healthResponse);
  check('/health answers 200', healthResponse.status === 200);
  check('/health reports the database connected', health.database?.connected === true);
  check('/health reports the analytics engine configured', health.analytics?.configured === true, JSON.stringify(health.analytics));
  check('/health reports an engine version', Boolean(health.analytics?.version), String(health.analytics?.version));
  console.log(`       r2 connected: ${health.r2?.connected === true}`);

  console.log('create a disposable guest workspace');
  const guestResponse = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: `analytics smoke ${randomUUID()}` }),
  });
  check('guest session is created', guestResponse.status === 201, String(guestResponse.status));
  if (guestResponse.status !== 201) throw new Error('cannot continue without a guest session');
  const guest = await json<GuestSession>(guestResponse);
  const bearer = { Authorization: `Bearer ${guest.sessionToken}` };
  const workspaceId = guest.workspace.id;

  const confirmSecret = `smoke-${randomUUID()}`;
  const confirm = await fetch(`${baseUrl}/api/me/confirm-secret`, {
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: confirmSecret }),
  });
  check('the confirmation gate is armed', confirm.status === 200, String(confirm.status));

  const keyResponse = await fetch(`${baseUrl}/api/keys`, {
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `analytics smoke ${randomUUID()}`,
      workspaceId,
      scopes: ['read', 'write'],
      confirmSecret,
    }),
  });
  check('a workspace key is minted', keyResponse.status === 201, String(keyResponse.status));
  if (keyResponse.status !== 201) throw new Error('cannot continue without a workspace key');
  const rawSecret = (await json<{ rawSecret: string }>(keyResponse)).rawSecret;
  const api = { Authorization: `Bearer ${rawSecret}`, 'Content-Type': 'application/json' };

  try {
    console.log('register the fixture as an immutable version');
    const registration = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/datasets`, {
      method: 'POST',
      headers: api,
      body: JSON.stringify(await fixtureRegistrationBody('smoke-job-history')),
    });
    const registeredBody = await registration.text();
    check('registration succeeds', registration.status === 201, `${registration.status} ${registeredBody}`);
    if (registration.status !== 201) throw new Error('registration failed');
    const version = (JSON.parse(registeredBody) as {
      datasetVersion: { id: string; version: number; rowCount: number; objectKeys: string[] };
    }).datasetVersion;
    check('version 1 is assigned', version.version === 1);
    check('the row count is the fixture row count', version.rowCount === FIXTURE_ROWS.length, String(version.rowCount));
    check('one object key per part is recorded', version.objectKeys.length === 2);

    console.log('submit and drain the named query');
    const submitted = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/analytics/queries`, {
      method: 'POST',
      headers: api,
      body: JSON.stringify({ datasetVersionId: version.id, querySpec: SPEC }),
    });
    check('the query is accepted', submitted.status === 201, String(submitted.status));
    if (submitted.status !== 201) throw new Error('query submission failed');
    const jobId = (await json<{ job: { id: string } }>(submitted)).job.id;

    const drain = await fetch(`${baseUrl}/api/jobs/run?workspaceId=${workspaceId}`, {
      method: 'POST',
      headers: api,
    });
    check('one queue pass drains', drain.status === 200, String(drain.status));

    const status = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/analytics/queries/${jobId}`, {
      headers: api,
    });
    const jobStatus = await json<{
      state: string;
      errorCode: string | null;
      errorSummary: string | null;
      resultId: string | null;
      result: { contentHash: string; rowCount: number; engineVersion: string } | null;
    }>(status);
    check('the job completes', jobStatus.state === 'completed', `${jobStatus.state} ${jobStatus.errorCode ?? ''} ${jobStatus.errorSummary ?? ''}`);
    check('the result records the engine version', Boolean(jobStatus.result?.engineVersion), String(jobStatus.result?.engineVersion));

    console.log('download and check the artifact');
    const content = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/analytics/results/${jobStatus.resultId}/content`,
      { headers: { Authorization: api.Authorization } }
    );
    check('the artifact downloads', content.status === 200, String(content.status));
    const bytes = Buffer.from(await content.arrayBuffer());
    check(
      'the artifact matches the recorded content hash',
      createHash('sha256').update(bytes).digest('hex') === jobStatus.result?.contentHash
    );
    const rows = await readResultRows(bytes);
    check('the aggregate is the known one', JSON.stringify(rows) === JSON.stringify(EXPECTED_AGGREGATE), JSON.stringify(rows));
  } finally {
    console.log('delete the disposable workspace');
    const deleted = await fetch(`${baseUrl}/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSecret, confirmSlug: guest.workspace.slug }),
    });
    if (deleted.status !== 200) {
      console.error(`  WARN cleanup failed (${deleted.status}); delete workspace ${workspaceId} by hand`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nanalytics-smoke: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nanalytics-smoke: all checks passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
