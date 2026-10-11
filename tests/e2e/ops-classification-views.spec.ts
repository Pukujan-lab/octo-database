/**
 * Playwright E2E: ops classification views (issue #140, slices O2, O3 and O5).
 *
 * The views are a pure-SQL analytics surface, so the first block seeds a known
 * row set directly and asserts both the aggregation and the fence:
 *
 *   - the counts/grouping a reader would act on, and
 *   - that reading through a view does NOT bypass RLS (`security_invoker`).
 *
 * The second point is the load-bearing one. A plain definer view owned by the
 * migration role would silently return every workspace's rows; scoped to W1 the
 * count must be W1's 3, not the cross-workspace 5.
 *
 * The second block (O3) pins the same views read back over HTTP: a real failing
 * job must show up through `GET /api/ops/summary`, and the route must refuse a
 * caller who is not a member of the workspace.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerQuery } from './owner-db';

const P = 'a0000000-0000-0000-0000-000000000001';
const P2 = 'a0000000-0000-0000-0000-000000000002';
const W1 = 'b0000000-0000-0000-0000-000000000001';
const W2 = 'b0000000-0000-0000-0000-000000000002';
const J1 = 'c0000000-0000-0000-0000-000000000001'; // W1 failed
const J2 = 'c0000000-0000-0000-0000-000000000002'; // W1 running, lease expired
const J3 = 'c0000000-0000-0000-0000-000000000003'; // W1 running, lease live (healthy)
const J4 = 'c0000000-0000-0000-0000-000000000004'; // W1 queued (healthy)
const J5 = 'c0000000-0000-0000-0000-000000000005'; // W2 failed

async function cleanup(): Promise<void> {
  await ownerQuery(`DELETE FROM octo.ops_events WHERE workspace_id = ANY($1)`, [[W1, W2]]);
  await ownerQuery(`DELETE FROM octo.jobs WHERE workspace_id = ANY($1)`, [[W1, W2]]);
  await ownerQuery(`DELETE FROM octo.workspace_memberships WHERE principal_id = ANY($1)`, [[P, P2]]);
  await ownerQuery(`DELETE FROM octo.workspaces WHERE id = ANY($1)`, [[W1, W2]]);
  await ownerQuery(`DELETE FROM octo.principals WHERE id = ANY($1)`, [[P, P2]]);
}

async function seed(codeA: string, codeB: string): Promise<void> {
  await ownerQuery(
    `INSERT INTO octo.principals (id, auth_user_id, email, display_name, is_guest, is_platform_owner)
     VALUES ($1, $3, $5, 'OpsViews Owner', false, false),
            ($2, $4, $6, 'OpsViews Other', false, false)`,
    [P, P2, 'a0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000012', 'opsv-owner@example.test', 'opsv-other@example.test']
  );
  await ownerQuery(
    `INSERT INTO octo.workspaces (id, slug, name, created_by) VALUES ($1,$3,$4,$5), ($2,$6,$7,$5)`,
    [W1, W2, 'opsv-w1', 'OpsViews W1', P, 'opsv-w2', 'OpsViews W2']
  );
  // One principal owns both workspaces, so membership alone would allow a
  // cross-workspace read; only the fence can deny it.
  await ownerQuery(
    `INSERT INTO octo.workspace_memberships (workspace_id, principal_id, role) VALUES ($1,$3,'owner'), ($2,$3,'owner')`,
    [W1, W2, P]
  );
  // W1: 3x codeA + 1x codeB. W2: 2x codeA.
  await ownerQuery(
    `INSERT INTO octo.ops_events (workspace_id, source, event_type, error_code, severity, job_type, created_at)
     VALUES
       ($1,'worker','job.failed',$3,'error','thumbnail', now() - interval '3 hours'),
       ($1,'worker','job.failed',$3,'error','thumbnail', now() - interval '2 hours'),
       ($1,'worker','job.failed',$3,'error','thumbnail', now() - interval '1 hour'),
       ($1,'worker','job.failed',$4,'error','thumbnail', now()),
       ($2,'worker','job.failed',$3,'error','thumbnail', now() - interval '1 hour'),
       ($2,'worker','job.failed',$3,'error','thumbnail', now())`,
    [W1, W2, codeA, codeB]
  );
  await ownerQuery(
    `INSERT INTO octo.jobs (id, workspace_id, job_type, state, idempotency_key, error_code, lease_expires_at)
     VALUES
       ($1,$6,'thumbnail','failed','opsv-j1',$8,NULL),
       ($2,$6,'thumbnail','running','opsv-j2',$8, now() - interval '5 minutes'),
       ($3,$6,'thumbnail','running','opsv-j3',NULL, now() + interval '5 minutes'),
       ($4,$6,'thumbnail','queued','opsv-j4',NULL,NULL),
       ($5,$7,'thumbnail','failed','opsv-j5',$8,NULL)`,
    [J1, J2, J3, J4, J5, W1, W2, codeA]
  );
}

test.describe('Ops classification views (slice O2)', () => {
  test('classify failures per workspace and surface unhealthy work, under the fence', async () => {
    const appUrl = process.env['OCTO_DB_URL'];
    const tag = randomUUID().slice(0, 8);
    const codeA = `OPSV_A_${tag}`;
    const codeB = `OPSV_B_${tag}`;

    await cleanup();
    await seed(codeA, codeB);

    const app = appUrl ? new pg.Client({ connectionString: appUrl }) : null;
    if (app) await app.connect();

    /** Runs `sql` as the fenced octo_app role with identity bound, transaction-locally. */
    async function scoped<T extends pg.QueryResultRow>(
      principalId: string,
      workspaceId: string,
      sql: string,
      params: unknown[] = []
    ): Promise<T[]> {
      await app!.query('BEGIN');
      try {
        await app!.query(`SELECT set_config('octo.principal_id', $1, true)`, [principalId]);
        await app!.query(`SELECT set_config('request.workspace_id', $1, true)`, [workspaceId]);
        const res = await app!.query<T>(sql, params);
        await app!.query('COMMIT');
        return res.rows;
      } catch (err) {
        await app!.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }

    try {
      // --- Aggregation correctness (read as the schema owner) ---

      const countsA = await ownerQuery<{ workspace_id: string; event_count: number }>(
        `SELECT workspace_id, event_count::int AS event_count
           FROM octo.ops_failure_counts WHERE error_code = $1 ORDER BY workspace_id`,
        [codeA]
      );
      expect(countsA).toEqual([
        { workspace_id: W1, event_count: 3 },
        { workspace_id: W2, event_count: 2 },
      ]);

      const countsB = await ownerQuery<{ event_count: number }>(
        `SELECT event_count::int AS event_count FROM octo.ops_failure_counts WHERE error_code = $1`,
        [codeB]
      );
      expect(countsB).toEqual([{ event_count: 1 }]);

      const byDay = await ownerQuery<{ total: number }>(
        `SELECT coalesce(sum(event_count), 0)::int AS total
           FROM octo.ops_failures_by_job_type_day WHERE error_code = $1 AND job_type = 'thumbnail'`,
        [codeA]
      );
      expect(byDay[0]!.total).toBe(5);

      const unhealthy = await ownerQuery<{ job_id: string }>(
        `SELECT job_id FROM octo.ops_unhealthy_jobs WHERE workspace_id = $1 ORDER BY job_id`,
        [W1]
      );
      // J3 (lease live) and J4 (queued) are healthy and excluded.
      expect(unhealthy.map((r) => r.job_id)).toEqual([J1, J2]);

      const unhealthyW2 = await ownerQuery<{ job_id: string }>(
        `SELECT job_id FROM octo.ops_unhealthy_jobs WHERE workspace_id = $1 ORDER BY job_id`,
        [W2]
      );
      expect(unhealthyW2.map((r) => r.job_id)).toEqual([J5]);

      // --- The fence: reading through a view must not bypass RLS ---
      test.skip(!app, 'OCTO_DB_URL (octo_app) is required for the fence assertions');

      const scopedW1 = await scoped<{ event_count: number }>(
        P,
        W1,
        `SELECT event_count::int AS event_count FROM octo.ops_failure_counts WHERE error_code = $1`,
        [codeA]
      );
      // 3, not 5: a definer view would leak W2's two rows here.
      expect(scopedW1).toEqual([{ event_count: 3 }]);

      const scopedW2 = await scoped<{ event_count: number }>(
        P,
        W2,
        `SELECT event_count::int AS event_count FROM octo.ops_failure_counts WHERE error_code = $1`,
        [codeA]
      );
      expect(scopedW2).toEqual([{ event_count: 2 }]);

      // P2 is not a member of W1: the member policy denies the read through the view.
      const scopedNonMember = await scoped<{ event_count: number }>(
        P2,
        W1,
        `SELECT event_count::int AS event_count FROM octo.ops_failure_counts WHERE error_code = $1`,
        [codeA]
      );
      expect(scopedNonMember).toEqual([]);

      const scopedUnhealthy = await scoped<{ job_id: string }>(
        P,
        W1,
        `SELECT job_id FROM octo.ops_unhealthy_jobs ORDER BY job_id`
      );
      expect(scopedUnhealthy.map((r) => r.job_id)).toEqual([J1, J2]);
    } finally {
      await cleanup();
      await app?.end().catch(() => undefined);
    }
  });
});

/**
 * Slice O3: the same views read back over HTTP through the fenced route.
 *
 * The route is the exposure slice -- no new aggregation -- so the property to pin
 * is that a real failure is classified and returned, and that the caller's own
 * authorization still applies: a non-member is refused, and so is an anonymous
 * caller.
 */
interface GuestSession {
  principal: { id: string };
  workspace: { id: string };
  sessionToken: string;
}

interface OpsSummaryBody {
  failureCounts: { errorCode: string | null; eventCount: number }[];
  failuresByJobTypeDay: { jobType: string; eventCount: number }[];
  unhealthyJobs: { jobId: string; state: string; errorCode: string | null }[];
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `OpsSummary E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as GuestSession;
}

test.describe('Ops summary route (slice O3)', () => {
  test('returns the classified failures the views produce, and refuses another workspace', async ({
    request,
  }) => {
    const guest = await createGuest(request);
    const workspaceId = guest.workspace.id;

    // A permanently-failing job is the deterministic source of both a failure
    // count and an unhealthy job, so the summary has something real to classify.
    const enqueued = await request.post('/api/jobs', {
      headers: bearer(guest.sessionToken),
      data: {
        workspaceId,
        jobType: 'thumbnail',
        idempotencyKey: `ops-summary-${randomUUID()}`,
        payload: {},
      },
    });
    expect(enqueued.status()).toBe(201);
    const jobId = ((await enqueued.json()) as { job: { id: string } }).job.id;

    const run = await request.post(`/api/jobs/run?workspaceId=${workspaceId}`, {
      headers: bearer(guest.sessionToken),
    });
    expect(run.status()).toBe(200);

    const response = await request.get(`/api/ops/summary?workspaceId=${workspaceId}`, {
      headers: bearer(guest.sessionToken),
    });
    expect(response.status()).toBe(200);
    const summary = (await response.json()) as OpsSummaryBody;

    const invalidPayload = summary.failureCounts.find((c) => c.errorCode === 'INVALID_PAYLOAD');
    expect(invalidPayload?.eventCount).toBe(1);
    expect(summary.failuresByJobTypeDay.some((d) => d.jobType === 'thumbnail')).toBe(true);
    expect(summary.unhealthyJobs.map((j) => j.jobId)).toContain(jobId);

    // A key bound to another workspace is refused before the read, and an
    // unauthenticated caller cannot reach the summary at all.
    const other = await createGuest(request);
    const crossWorkspace = await request.get(
      `/api/ops/summary?workspaceId=${workspaceId}`,
      { headers: bearer(other.sessionToken) }
    );
    expect(crossWorkspace.status()).toBe(403);

    const anonymous = await request.get(`/api/ops/summary?workspaceId=${workspaceId}`);
    expect(anonymous.status()).toBe(401);
  });
});

/**
 * Slice O5: the same classification, rendered for a human on the operations page.
 *
 * This is the exposure slice for the panel -- no new aggregation -- so the property
 * to pin is that a real, freshly recorded failure is classified and shown in the
 * browser, and that the reader can act on the job needing attention.
 */
test.describe('Ops failure panel (slice O5)', () => {
  test('renders the classified failures the summary route returns', async ({ page, request }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    // Drive the failure through the API with the browser's own session, then reload
    // so the operations view loads the freshly recorded classification.
    const token = await page.evaluate(() => localStorage.getItem('octo_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const workspaces = await request.get('/api/workspaces', { headers: auth });
    expect(workspaces.status()).toBe(200);
    const workspaceId = ((await workspaces.json()) as { id: string }[])[0]!.id;

    const enqueued = await request.post('/api/jobs', {
      headers: auth,
      data: {
        workspaceId,
        jobType: 'thumbnail',
        idempotencyKey: `ops-panel-${randomUUID()}`,
        payload: {},
      },
    });
    expect(enqueued.status()).toBe(201);
    const run = await request.post(`/api/jobs/run?workspaceId=${workspaceId}`, { headers: auth });
    expect(run.status()).toBe(200);

    await page.reload();
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await page
      .locator('[data-testid="app-nav"]')
      .getByRole('button', { name: 'Operations', exact: true })
      .click();

    await expect(page.getByRole('heading', { name: 'Failure analysis' })).toBeVisible();
    // The permanent INVALID_PAYLOAD failure is classified by code...
    await expect(page.getByText('INVALID_PAYLOAD', { exact: true }).first()).toBeVisible();
    // ...rolled up by job type and day...
    await expect(page.getByText('By job type and day', { exact: true })).toBeVisible();
    // ...and the job itself is listed as needing attention, with the repair action.
    await expect(page.getByText('Jobs needing attention', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
  });
});
