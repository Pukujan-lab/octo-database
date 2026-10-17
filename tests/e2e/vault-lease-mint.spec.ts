/**
 * Working keys: an agent exchanges a grant for one key scoped to one stored
 * item, and that key is fenced out of every cabinet surface.
 *
 * The key is a credential, not a session and not a grant: it cannot open the
 * cabinet, cannot list items, and cannot be used as an API key. Revoking it
 * from the dashboard takes it out of the list.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';

interface GuestSession {
  workspace: { id: string };
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Lease Mint ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

test.describe('vault working keys', () => {
  test('a grant mints one key per item, the key cannot open the cabinet, and revoking it removes it', async ({
    request,
  }) => {
    const session = await createGuest(request);

    const stored = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: {
        label: 'Fish Audio',
        description: 'TTS vendor key.',
        kind: 'token',
        secret: `fish-${randomUUID()}`,
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(stored.status()).toBe(201);
    const itemId = ((await stored.json()) as { item: { id: string } }).item.id;

    const route = await request.post(`/api/vault/items/${itemId}/routes`, {
      headers: bearer(session.sessionToken),
      data: {
        name: 'Fish Audio API',
        baseUrl: 'https://api.fish.audio',
        authScheme: 'bearer',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(route.status()).toBe(201);
    const routeKey = ((await route.json()) as { route: { routeKey: string } }).route.routeKey;
    expect(routeKey.length).toBeGreaterThan(0);

    const minted = await request.post('/api/vault/grants', {
      headers: bearer(session.sessionToken),
      data: { name: 'agent', expiresInHours: 10, confirmSecret: CONFIRM_SECRET },
    });
    expect(minted.status()).toBe(201);
    const grantSecret = ((await minted.json()) as { rawSecret: string }).rawSecret;

    const cabinet = await request.get('/api/vault/open', { headers: bearer(grantSecret) });
    expect(cabinet.status()).toBe(200);
    const cabinetBody = (await cabinet.json()) as {
      items: Array<{ label: string; routes: Array<{ routeKey: string; url: string }> }>;
    };
    expect(cabinetBody.items[0]?.routes[0]?.routeKey).toBe(routeKey);
    expect(cabinetBody.items[0]?.routes[0]?.url).toContain(`/api/vault/relay/${routeKey}`);

    const lease = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { label: 'Fish Audio', expiresInDays: 15 },
    });
    expect(lease.status()).toBe(201);
    const leaseBody = (await lease.json()) as {
      lease: { id: string; itemLabel: string; expiresAt: string };
      rawSecret: string;
      routes: Array<{ routeKey: string }>;
    };
    expect(leaseBody.rawSecret.startsWith('octo_tmp_')).toBe(true);
    expect(leaseBody.lease.itemLabel).toBe('Fish Audio');
    expect(leaseBody.routes[0]?.routeKey).toBe(routeKey);

    const workingKey = leaseBody.rawSecret;
    expect((await request.get('/api/vault/open', { headers: bearer(workingKey) })).status()).toBe(401);
    expect((await request.get('/api/vault/items', { headers: bearer(workingKey) })).status()).toBe(401);
    expect(
      (await request.get('/api/vault/grants', { headers: bearer(workingKey) })).status()
    ).toBe(401);

    const listed = await request.get('/api/vault/leases', { headers: bearer(session.sessionToken) });
    expect(listed.status()).toBe(200);
    const leases = ((await listed.json()) as { leases: Array<{ id: string; revokedAt: string | null }> }).leases;
    expect(leases.some((row) => row.id === leaseBody.lease.id && row.revokedAt === null)).toBe(true);

    const revoked = await request.delete(`/api/vault/leases/${leaseBody.lease.id}`, {
      headers: bearer(session.sessionToken),
      data: { confirmSecret: CONFIRM_SECRET },
    });
    expect(revoked.status()).toBe(200);

    const after = await request.get('/api/vault/leases', { headers: bearer(session.sessionToken) });
    const afterLeases = ((await after.json()) as { leases: Array<{ id: string; revokedAt: string | null }> }).leases;
    expect(afterLeases.find((row) => row.id === leaseBody.lease.id)?.revokedAt).not.toBeNull();

    const secondMint = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { itemId, expiresInDays: 1 },
    });
    expect(secondMint.status()).toBe(201);

    const decoy = await request.post('/api/vault/open/decoy', {
      headers: bearer(grantSecret),
      data: { expiresInHours: 5 },
    });
    const decoySecret = ((await decoy.json()) as { rawSecret: string }).rawSecret;
    const decoyLease = await request.post('/api/vault/open/lease', {
      headers: bearer(decoySecret),
      data: { itemId },
    });
    expect(decoyLease.status()).toBe(403);
  });
});
