/**
 * Playwright E2E: the analytics hidden holdout (Slice 7).
 *
 * The public fixture is one dataset label, two job types, and two month parts.
 * This suite answers a question the implementation was not tuned on: unseen
 * labels and a third job type, a different partition layout (three parts), and a
 * range that crosses a year boundary. The expected aggregate is computed here by
 * hand, independent of DuckDB and of PostgreSQL.
 *
 * It also asserts the public fixture's answers do not leak into this result, and
 * that the Parquet footer -- not the caller's declaration -- is authoritative.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';
import {
  FIXTURE_SCHEMA,
  FixtureRow,
  parquetBytes,
  readResultRows,
} from '../../scripts/analytics-fixture';

interface GuestSession {
  principal: { id: string; isGuest: boolean };
  workspace: { id: string; slug: string; role: string };
  sessionToken: string;
}

interface MintedKey {
  rawSecret: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const SPEC = 'job-failures-by-type-month@1';

// Unseen labels: none of these appear in the public fixture.
const ROWS: FixtureRow[] = [
  { job_type: 'export_pdf', state: 'failed', created_at: '2025-11-03 09:00:00' },
  { job_type: 'export_pdf', state: 'failed', created_at: '2025-12-31 23:59:59' },
  { job_type: 'export_pdf', state: 'failed', created_at: '2026-01-01 00:00:00' },
  { job_type: 'export_pdf', state: 'completed', created_at: '2026-01-10 10:00:00' },
  { job_type: 'sync_index', state: 'failed', created_at: '2026-01-15 08:00:00' },
  { job_type: 'sync_index', state: 'failed', created_at: '2026-01-20 08:00:00' },
  { job_type: 'reindex', state: 'failed', created_at: '2026-02-01 00:00:00' },
  { job_type: 'reindex', state: 'failed', created_at: '2026-02-27 12:00:00' },
  { job_type: 'reindex', state: 'completed', created_at: '2026-02-28 23:59:59' },
];

// A three-part layout: the pre-year-end rows in one file, then one file per month.
const PARTS: Array<{ partition: string; rows: FixtureRow[] }> = [
  { partition: '2025-12-31', rows: ROWS.filter((row) => row.created_at < '2026-01-01') },
  { partition: '2026-01-31', rows: ROWS.filter((row) => row.created_at.startsWith('2026-01')) },
  { partition: '2026-02-28', rows: ROWS.filter((row) => row.created_at.startsWith('2026-02')) },
];

// Counted by hand from ROWS (failed only), in the contract's canonical order.
const EXPECTED = [
  { job_type: 'export_pdf', month: '2025-11-01', failure_count: 1 },
  { job_type: 'export_pdf', month: '2025-12-01', failure_count: 1 },
  { job_type: 'export_pdf', month: '2026-01-01', failure_count: 1 },
  { job_type: 'reindex', month: '2026-02-01', failure_count: 2 },
  { job_type: 'sync_index', month: '2026-01-01', failure_count: 2 },
];

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Analytics holdout ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function mintKey(
  request: APIRequestContext,
  sessionToken: string,
  workspaceId: string
): Promise<MintedKey> {
  const response = await request.post('/api/keys', {
    headers: bearer(sessionToken),
    data: {
      name: `holdout key ${randomUUID()}`,
      workspaceId,
      scopes: ['read', 'write'],
      confirmSecret: CONFIRM_SECRET,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as MintedKey;
}

async function registrationBody(parts: Array<{ partition: string; rows: FixtureRow[] }>, schema = FIXTURE_SCHEMA) {
  const encoded: Array<{ partition: string; dataBase64: string }> = [];
  for (const part of parts) {
    encoded.push({ partition: part.partition, dataBase64: (await parquetBytes(part.rows)).toString('base64') });
  }
  return {
    dataset: 'holdout-job-history',
    name: 'Unseen holdout export',
    format: 'parquet' as const,
    schema,
    provenance: { source: 'holdout.synthetic', exportedAt: '2026-03-01T00:00:00Z' },
    watermark: '2026-02-28T23:59:59Z',
    parts: encoded,
  };
}

test.describe('Historical analytics hidden holdout', () => {
  test('unseen labels and a year-crossing three-part layout answer correctly', async ({ request }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id);
    const workspaceId = owner.workspace.id;

    const registration = await request.post(`/api/workspaces/${workspaceId}/datasets`, {
      headers: bearer(key.rawSecret),
      data: await registrationBody(PARTS),
    });
    expect(registration.status()).toBe(201);
    const version = (await registration.json()) as {
      datasetVersion: { id: string; version: number; rowCount: number; objectKeys: string[] };
    };
    expect(version.datasetVersion.version).toBe(1);
    expect(version.datasetVersion.rowCount).toBe(ROWS.length);
    expect(version.datasetVersion.objectKeys).toHaveLength(3);

    const submitted = await request.post(`/api/workspaces/${workspaceId}/analytics/queries`, {
      headers: bearer(key.rawSecret),
      data: { datasetVersionId: version.datasetVersion.id, querySpec: SPEC },
    });
    expect(submitted.status()).toBe(201);
    const jobId = ((await submitted.json()) as { job: { id: string } }).job.id;

    const drain = await request.post(`/api/jobs/run?workspaceId=${workspaceId}`, {
      headers: bearer(key.rawSecret),
    });
    expect(drain.status()).toBe(200);

    const status = await request.get(`/api/workspaces/${workspaceId}/analytics/queries/${jobId}`, {
      headers: bearer(key.rawSecret),
    });
    expect(status.status()).toBe(200);
    const jobStatus = (await status.json()) as {
      state: string;
      errorCode: string | null;
      resultId: string | null;
      result: { rowCount: number } | null;
    };
    expect(jobStatus.errorCode).toBeNull();
    expect(jobStatus.state).toBe('completed');
    expect(jobStatus.result?.rowCount).toBe(EXPECTED.length);

    const content = await request.get(
      `/api/workspaces/${workspaceId}/analytics/results/${jobStatus.resultId}/content`,
      { headers: bearer(key.rawSecret) }
    );
    expect(content.status()).toBe(200);
    const rows = await readResultRows(await content.body());

    expect(rows).toEqual(EXPECTED);

    // The public fixture's answers must not appear here: different labels, a
    // different type count, and none of its three aggregates.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('archive_file');
    expect(serialized).not.toContain('thumbnail');
    expect(rows).toHaveLength(EXPECTED.length);
    expect(new Set(rows.map((row) => row.job_type)).size).toBe(3);
  });

  test('the Parquet footer, not the declaration, is authoritative', async ({ request }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id);
    const workspaceId = owner.workspace.id;

    // The declaration names a fourth column the Parquet files do not carry. The
    // required spec inputs are present, so the refusal comes from footer
    // inspection, not from the pre-flight schema check.
    const lying = await request.post(`/api/workspaces/${workspaceId}/datasets`, {
      headers: bearer(key.rawSecret),
      data: await registrationBody(PARTS, [
        ...FIXTURE_SCHEMA,
        { name: 'region', type: 'TEXT' },
      ]),
    });
    expect(lying.status()).toBe(400);
    const refusal = (await lying.json()) as { error: string; message: string };
    expect(refusal.error).toBe('SCHEMA_MISMATCH');
    expect(refusal.message).toMatch(/footer/i);
  });
});
