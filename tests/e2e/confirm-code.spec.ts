import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('a human types a fresh code to mint a workspace key, with no saved password', async ({ request }) => {
  const guest = await request.post('/api/auth/guest', { data: { displayName: 'Code guest' } });
  expect(guest.status()).toBe(201);
  const session = (await guest.json()) as { sessionToken: string; workspace: { id: string } };
  const issued = await request.post('/api/me/confirm-challenge', {
    headers: { Authorization: `Bearer ${session.sessionToken}` },
  });
  expect(issued.status()).toBe(200);
  const { code } = (await issued.json()) as { code: string };
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  const wrong = await request.post('/api/keys', {
    headers: { Authorization: `Bearer ${session.sessionToken}` },
    data: { name: `Wrong ${randomUUID()}`, workspaceId: session.workspace.id, confirmSecret: 'AAAAAA' },
  });
  expect(wrong.status()).toBe(403);

  const minted = await request.post('/api/keys', {
    headers: { Authorization: `Bearer ${session.sessionToken}` },
    data: {
      name: `Typed ${randomUUID()}`,
      workspaceId: session.workspace.id,
      confirmSecret: code.toLowerCase(),
    },
  });
  expect(minted.status()).toBe(201);
});

test('a human with no saved secret recovers when the shown code is gone', async ({ request }) => {
  const guest = await request.post('/api/auth/guest', { data: { displayName: 'Lost code guest' } });
  expect(guest.status()).toBe(201);
  const session = (await guest.json()) as { sessionToken: string };
  const headers = { Authorization: `Bearer ${session.sessionToken}` };
  const label = `Lost ${randomUUID()}`;

  // No code has been issued in this process for this principal -- the state
  // after a restart wiped the in-memory challenge. The gate must hand back a
  // fresh code, not demand a saved confirmation secret.
  const stale = await request.post('/api/vault/items', {
    headers,
    data: { label, kind: 'token', description: 'recovery probe', secret: 'value', confirmSecret: 'AAAAAA' },
  });
  expect(stale.status()).toBe(403);
  expect(((await stale.json()) as { error: string }).error).toContain('CONFIRM_CODE_INVALID');

  const issued = await request.post('/api/me/confirm-challenge', { headers });
  expect(issued.status()).toBe(200);
  const { code } = (await issued.json()) as { code: string };

  const saved = await request.post('/api/vault/items', {
    headers,
    data: { label, kind: 'token', description: 'recovery probe', secret: 'value', confirmSecret: code },
  });
  expect(saved.status()).toBe(201);
});
