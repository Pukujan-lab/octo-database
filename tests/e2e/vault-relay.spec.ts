/**
 * The relay: a working key terminates at Octo, the stored secret is injected
 * upstream, and the vendor's response is streamed back.
 *
 * The upstream here is Octo's own `/health`, so the test needs no external
 * network and no real vendor credential.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';

const UPSTREAM_ORIGIN = 'http://localhost:3001';

interface GuestSession {
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Relay ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

test.describe('vault relay', () => {
  test('a working key is forwarded to the route upstream and stops working when revoked', async ({
    request,
  }) => {
    const session = await createGuest(request);
    const auth = bearer(session.sessionToken);

    const stored = await request.post('/api/vault/items', {
      headers: auth,
      data: {
        label: 'Octo self',
        description: 'Route used to prove the relay forwards.',
        kind: 'token',
        secret: `self-${randomUUID()}`,
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(stored.status()).toBe(201);
    const itemId = ((await stored.json()) as { item: { id: string } }).item.id;

    const route = await request.post(`/api/vault/items/${itemId}/routes`, {
      headers: auth,
      data: {
        name: 'Octo health',
        baseUrl: UPSTREAM_ORIGIN,
        authScheme: 'bearer',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(route.status()).toBe(201);
    const routeKey = ((await route.json()) as { route: { routeKey: string } }).route.routeKey;

    const healthPass = await request.post('/api/vault/health', {
      headers: auth,
      data: { confirmSecret: CONFIRM_SECRET },
    });
    expect(healthPass.status()).toBe(200);
    const checkedRoutes = (
      (await healthPass.json()) as { checkedRoutes: Array<{ routeKey: string; healthStatus: string }> }
    ).checkedRoutes;
    expect(checkedRoutes).toEqual([expect.objectContaining({ routeKey, healthStatus: 'ok' })]);

    const afterHealthPass = await request.get(`/api/vault/items/${itemId}/routes`, { headers: auth });
    const probed = ((await afterHealthPass.json()) as { routes: Array<{ healthStatus: string }> }).routes;
    expect(probed[0]?.healthStatus).toBe('ok');

    const minted = await request.post('/api/vault/grants', {
      headers: auth,
      data: { name: 'relay agent', expiresInHours: 10, confirmSecret: CONFIRM_SECRET },
    });
    expect(minted.status()).toBe(201);
    const grantSecret = ((await minted.json()) as { rawSecret: string }).rawSecret;

    const lease = await request.post('/api/vault/open/lease', {
      headers: bearer(grantSecret),
      data: { itemId, expiresInDays: 1 },
    });
    expect(lease.status()).toBe(201);
    const leaseBody = (await lease.json()) as { lease: { id: string }; rawSecret: string };
    const workingKey = leaseBody.rawSecret;

    const relayed = await request.get(`/api/vault/relay/${routeKey}/health`, {
      headers: bearer(workingKey),
    });
    expect(relayed.status()).toBe(200);
    expect(((await relayed.json()) as { status: string }).status).toBe('ok');

    const afterRelay = await request.get(`/api/vault/items/${itemId}/routes`, { headers: auth });
    const routes = ((await afterRelay.json()) as { routes: Array<{ healthStatus: string }> }).routes;
    expect(routes[0]?.healthStatus).toBe('ok');

    const wrongRoute = await request.get('/api/vault/relay/not-a-route/health', {
      headers: bearer(workingKey),
    });
    expect(wrongRoute.status()).toBe(401);

    const noKey = await request.get(`/api/vault/relay/${routeKey}/health`);
    expect(noKey.status()).toBe(401);

    const revoked = await request.delete(`/api/vault/leases/${leaseBody.lease.id}`, {
      headers: auth,
      data: { confirmSecret: CONFIRM_SECRET },
    });
    expect(revoked.status()).toBe(200);

    const afterRevoke = await request.get(`/api/vault/relay/${routeKey}/health`, {
      headers: bearer(workingKey),
    });
    expect(afterRevoke.status()).toBe(401);
  });
});
