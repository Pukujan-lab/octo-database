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
    const storedSecret = `fish-${randomUUID()}`;

    const stored = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: {
        label: 'Fish Audio',
        description: 'TTS vendor key.',
        kind: 'token',
        secret: storedSecret,
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

    // The inventory names the item without disclosing its secret.
    expect(JSON.stringify(cabinetBody)).not.toContain(storedSecret);

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

  test('a route-less item needs a baseUrl at lease time, and that baseUrl becomes its route', async ({
    request,
  }) => {
    const session = await createGuest(request);

    const bare = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: {
        label: 'Bare token',
        description: 'A token with nowhere to send it.',
        kind: 'token',
        secret: `bare-${randomUUID()}`,
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(bare.status()).toBe(201);
    const bareId = ((await bare.json()) as { item: { id: string } }).item.id;

    const withUrl = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: {
        label: 'Url token',
        description: 'A token that carries its own base url.',
        kind: 'token',
        url: 'https://api.inferhub.dev/v1',
        secret: `url-${randomUUID()}`,
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(withUrl.status()).toBe(201);
    const urlId = ((await withUrl.json()) as { item: { id: string } }).item.id;

    const minted = await request.post('/api/vault/grants', {
      headers: bearer(session.sessionToken),
      data: { name: 'routes', expiresInHours: 10, confirmSecret: CONFIRM_SECRET },
    });
    const grantSecret = ((await minted.json()) as { rawSecret: string }).rawSecret;

    const refused = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { itemId: bareId },
    });
    expect(refused.status()).toBe(400);
    const refusedBody = (await refused.json()) as {
      error: string;
      code: string;
      itemId: string;
      requires: string;
    };
    expect(refusedBody.code).toBe('ROUTE_REQUIRED');
    expect(refusedBody.itemId).toBe(bareId);
    expect(refusedBody.requires).toBe('baseUrl');
    expect(refusedBody.error).toContain('ROUTE_REQUIRED');

    // A grant cannot reach the owner-only item and route endpoints.
    const ownerOnly = await request.get(`/api/vault/items/${bareId}`, { headers: bearer(grantSecret) });
    expect(ownerOnly.status()).toBe(403);

    // No route was created for the item that could not use one.
    const bareRoutes = await request.get(`/api/vault/items/${bareId}/routes`, {
      headers: bearer(session.sessionToken),
    });
    expect(((await bareRoutes.json()) as { routes: unknown[] }).routes).toHaveLength(0);

    // Naming the vendor base URL at lease time makes the imported token usable.
    const leased = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: {
        itemId: bareId,
        expiresInDays: 1,
        baseUrl: 'https://api.vendor.test/v1',
        authScheme: 'x-api-key',
        authHeader: 'X-Api-Key',
      },
    });
    expect(leased.status()).toBe(201);
    const leasedBody = (await leased.json()) as { routes: Array<{ routeKey: string; baseUrl: string }> };
    expect(leasedBody.routes).toHaveLength(1);
    expect(leasedBody.routes[0]?.baseUrl).toBe('https://api.vendor.test/v1');
    expect(leasedBody.routes[0]?.routeKey).toContain('-auto');

    // The derived route is persisted for the owner, with the scheme it was
    // leased under.
    const persisted = await request.get(`/api/vault/items/${bareId}/routes`, {
      headers: bearer(session.sessionToken),
    });
    const persistedRoutes = (
      (await persisted.json()) as { routes: Array<{ routeKey: string; authScheme: string; authHeader: string }> }
    ).routes;
    expect(persistedRoutes).toHaveLength(1);
    expect(persistedRoutes[0]?.routeKey).toBe(leasedBody.routes[0]?.routeKey);
    expect(persistedRoutes[0]?.authScheme).toBe('x-api-key');
    expect(persistedRoutes[0]?.authHeader).toBe('X-Api-Key');

    // A later lease with no baseUrl reuses the route instead of adding another.
    const second = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { itemId: bareId },
    });
    expect(second.status()).toBe(201);
    expect(((await second.json()) as { routes: unknown[] }).routes).toHaveLength(1);

    const derived = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { itemId: urlId },
    });
    expect(derived.status()).toBe(201);
    const derivedBody = (await derived.json()) as { routes: Array<{ routeKey: string; baseUrl: string }> };
    expect(derivedBody.routes).toHaveLength(1);
    expect(derivedBody.routes[0]?.baseUrl).toBe('https://api.inferhub.dev/v1');
    expect(derivedBody.routes[0]?.routeKey).toContain('-auto');

    // Minting again reuses the derived route instead of adding a second one.
    const secondDerived = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { itemId: urlId },
    });
    expect(secondDerived.status()).toBe(201);
    expect(((await secondDerived.json()) as { routes: unknown[] }).routes).toHaveLength(1);
  });
});
