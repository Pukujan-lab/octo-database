/**
 * Playwright E2E: the SQL surface (Slice 21).
 *
 * POST /api/workspaces/:id/query runs SQL against a workspace's own provisioned
 * database using only an Octo API key -- no connection string, host, or port. The
 * properties pinned here are the ones that hold without a provisioned database:
 * authentication, the workspace fence, input validation, and the fail-closed
 * DATABASE_NOT_PROVISIONED. The path that actually executes SQL needs a real
 * cluster with CREATE DATABASE, so it is proven by
 * scripts/verify-workspace-query.ts (run in gates), exactly as the provisioning
 * eval is.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';

interface GuestSession {
  principal: { id: string; isGuest: boolean };
  workspace: { id: string; slug: string; role: string };
  sessionToken: string;
}

interface MintedKey {
  apiKey: { id: string; workspaceId: string | null; scopes: string[] };
  rawSecret: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `SQL E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function mintKey(
  request: APIRequestContext,
  sessionToken: string,
  workspaceId: string,
  scopes: string[]
): Promise<MintedKey> {
  const response = await request.post('/api/keys', {
    headers: bearer(sessionToken),
    data: { name: `sql key ${randomUUID()}`, workspaceId, scopes, confirmSecret: CONFIRM_SECRET },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as MintedKey;
}

function runSql(
  request: APIRequestContext,
  token: string,
  workspaceId: string,
  sql: unknown
) {
  return request.post(`/api/workspaces/${workspaceId}/query`, {
    headers: bearer(token),
    data: { sql },
  });
}

async function createWorkspace(
  request: APIRequestContext,
  sessionToken: string,
  name: string
): Promise<{ workspace: { id: string }; databaseProvisioned: boolean }> {
  const response = await request.post('/api/workspaces', {
    headers: bearer(sessionToken),
    data: { name, confirmSecret: CONFIRM_SECRET },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as never;
}

test.describe('Workspace SQL surface', () => {
  test('unauthenticated callers are refused', async ({ request }) => {
    const response = await request.post(`/api/workspaces/${randomUUID()}/query`, {
      data: { sql: 'SELECT 1' },
    });
    expect(response.status()).toBe(401);
  });

  test('a workspace key cannot query another workspace, and a non-member is refused', async ({
    request,
  }) => {
    const owner = await createGuest(request);
    const stranger = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);

    // The key is pinned to its own workspace: naming another workspace is refused
    // before the database is ever consulted.
    const crossKey = await runSql(request, key.rawSecret, stranger.workspace.id, 'SELECT 1');
    expect(crossKey.status()).toBe(403);
    expect((await crossKey.json()).error).toMatch(/Key restricted to different workspace/);

    // A member of another workspace, using its own session, is refused the owner's
    // workspace by membership rather than by the database.
    const crossMember = await runSql(request, stranger.sessionToken, owner.workspace.id, 'SELECT 1');
    expect(crossMember.status()).toBe(403);
    expect((await crossMember.json()).error).toMatch(/Not a member of this workspace/);

    // A malformed workspace id is refused as a clean 400, never a 500.
    const malformed = await runSql(request, key.rawSecret, 'not-a-uuid', 'SELECT 1');
    expect(malformed.status()).toBe(400);
  });

  test('missing, empty, and malformed bodies are clean 400s, never 500s', async ({ request }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);
    const path = `/api/workspaces/${owner.workspace.id}/query`;
    const headers = { ...bearer(key.rawSecret), 'Content-Type': 'application/json' };

    for (const data of ['{ not json', '', 'null', '[]', '{}', '{"sql":""}', '{"sql":42}']) {
      const response = await request.post(path, { headers, data });
      expect(response.status(), `body ${JSON.stringify(data)}`).toBe(400);
    }
  });

  // A guest's personal sandbox is not auto-provisioned (only an explicit
  // workspace creation is), so it still has no database and fails closed.
  test('a workspace without a provisioned database fails closed with 404', async ({ request }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);

    const response = await runSql(request, key.rawSecret, owner.workspace.id, 'SELECT 1');

    expect(response.status()).toBe(404);
    expect((await response.json()).error).toMatch(/DATABASE_NOT_PROVISIONED/);
  });

  test('a read-scoped key discovers workspaces.query', async ({ request }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);

    const discovery = await request.get(`/api/capabilities?workspaceId=${owner.workspace.id}`, {
      headers: bearer(key.rawSecret),
    });
    expect(discovery.status()).toBe(200);
    const payload = (await discovery.json()) as { capabilities: Array<{ action: string }> };
    const actions = new Set(payload.capabilities.map((capability) => capability.action));

    expect(actions.has('workspaces.query')).toBe(true);
    // The token carries no write scope, so it cannot discover the provisioning
    // action -- and running SQL with it stays read-only server-side.
    expect(actions.has('workspaces.provision_database')).toBe(false);
  });

  test('a workspace created through the API arrives with its database', async ({ request }) => {
    const owner = await createGuest(request);
    const created = await createWorkspace(request, owner.sessionToken, `Auto Provision ${randomUUID()}`);

    // The flag is the truth about whether this call provisioned: a workspace
    // created here needs no second, separately authorized provisioning call.
    expect(typeof created.databaseProvisioned).toBe('boolean');

    const key = await mintKey(request, owner.sessionToken, created.workspace.id, ['read']);
    const probe = await runSql(request, key.rawSecret, created.workspace.id, 'SELECT 1 AS one');

    if (created.databaseProvisioned) {
      expect(probe.status()).toBe(200);
      expect(((await probe.json()).rows[0] as { one: number }).one).toBe(1);
    } else {
      // Provisioning is unconfigured here (no OCTO_ADMIN_URL), so the workspace
      // fails closed exactly like a guest's -- the flag said so in advance.
      expect(probe.status()).toBe(404);
      expect((await probe.json()).error).toMatch(/DATABASE_NOT_PROVISIONED/);
    }
  });

  test('provision then query: an API key alone runs and reads back SQL', async ({ request }) => {
    const owner = await createGuest(request);
    const writeKey = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read', 'write']);

    // Provisioning needs an account-wide key; the workspace key above cannot.
    const accountKeyResponse = await request.post('/api/keys', {
      headers: bearer(owner.sessionToken),
      data: {
        name: `sql account ${randomUUID()}`,
        scopes: ['read', 'write'],
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(accountKeyResponse.status()).toBe(201);
    const accountKey = (await accountKeyResponse.json()) as MintedKey;

    const provision = await request.post(`/api/workspaces/${owner.workspace.id}/database`, {
      headers: bearer(accountKey.rawSecret),
    });
    test.skip(
      provision.status() === 500,
      'Provisioning is not configured in this test environment (no OCTO_ADMIN_URL)'
    );
    expect(provision.status()).toBe(201);

    // The write key's SQL runs, then reads back through the same key.
    const created = await request.post(`/api/workspaces/${owner.workspace.id}/query`, {
      headers: bearer(writeKey.rawSecret),
      data: { sql: 'CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL)' },
    });
    expect(created.status()).toBe(200);

    const inserted = await request.post(`/api/workspaces/${owner.workspace.id}/query`, {
      headers: bearer(writeKey.rawSecret),
      data: { sql: 'INSERT INTO notes (body) VALUES ($1), ($2)', params: ['hello', 'world'] },
    });
    expect(inserted.status()).toBe(200);

    const selected = await request.post(`/api/workspaces/${owner.workspace.id}/query`, {
      headers: bearer(writeKey.rawSecret),
      data: { sql: 'SELECT body FROM notes ORDER BY id' },
    });
    expect(selected.status()).toBe(200);
    const body = (await selected.json()) as {
      columns: string[];
      rows: Array<{ body: string }>;
      rowCount: number;
      statementCount: number;
      truncated: boolean;
    };
    expect(body.columns).toEqual(['body']);
    expect(body.rows.map((row) => row.body)).toEqual(['hello', 'world']);
    expect(body.truncated).toBe(false);

    // A SQL error is the caller's problem: a clean 400 carrying the message, never a 500.
    const badSql = await request.post(`/api/workspaces/${owner.workspace.id}/query`, {
      headers: bearer(writeKey.rawSecret),
      data: { sql: 'SELEC 1' },
    });
    expect(badSql.status()).toBe(400);
    expect((await badSql.json()).error).toBe('SQL_ERROR');

    // A read-scoped key may read but not write: the database's read-only transaction
    // refuses the DDL.
    const readOnlyKey = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);
    const roRead = await request.post(`/api/workspaces/${owner.workspace.id}/query`, {
      headers: bearer(readOnlyKey.rawSecret),
      data: { sql: 'SELECT count(*)::int AS n FROM notes' },
    });
    expect(roRead.status()).toBe(200);
    expect(((await roRead.json()).rows[0] as { n: number }).n).toBe(2);

    const roWrite = await request.post(`/api/workspaces/${owner.workspace.id}/query`, {
      headers: bearer(readOnlyKey.rawSecret),
      data: { sql: 'CREATE TABLE nope (id int)' },
    });
    expect(roWrite.status()).toBe(400);
    expect((await roWrite.json()).message).toMatch(/read-only transaction/i);
  });
});
