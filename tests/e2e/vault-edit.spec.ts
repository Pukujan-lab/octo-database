/**
 * Editing a stored key.
 *
 * A PATCH rewrites the editable fields. Leaving `secret` out keeps the stored
 * secret; sending it replaces the value and resets the health reading, because
 * the old probe result described a different secret.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';

interface GuestSession {
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Vault Edit ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function createItem(request: APIRequestContext, token: string): Promise<{ id: string; label: string }> {
  const label = `Edit ${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/vault/items', {
    headers: bearer(token),
    data: {
      label,
      description: 'before',
      kind: 'token',
      secret: 'first-secret',
      notes: 'kept note',
      confirmSecret: CONFIRM_SECRET,
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { item: { id: string } };
  return { id: body.item.id, label };
}

test.describe('vault item edit', () => {
  test('an edit without a secret keeps the stored secret and the notes', async ({ request }) => {
    const session = await createGuest(request);
    const item = await createItem(request, session.sessionToken);

    const response = await request.patch(`/api/vault/items/${item.id}`, {
      headers: bearer(session.sessionToken),
      data: {
        label: `${item.label} renamed`,
        description: 'after',
        kind: 'token',
        notes: 'kept note',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(response.status()).toBe(200);

    const revealed = await request.get(`/api/vault/items/${item.id}`, { headers: bearer(session.sessionToken) });
    expect(revealed.status()).toBe(200);
    const body = (await revealed.json()) as {
      item: { label: string; description: string; secret: string | null; notes: string | null };
    };
    expect(body.item.label).toBe(`${item.label} renamed`);
    expect(body.item.description).toBe('after');
    expect(body.item.secret).toBe('first-secret');
    expect(body.item.notes).toBe('kept note');
  });

  test('sending a new secret replaces it and resets the health reading', async ({ request }) => {
    const session = await createGuest(request);
    const item = await createItem(request, session.sessionToken);

    const response = await request.patch(`/api/vault/items/${item.id}`, {
      headers: bearer(session.sessionToken),
      data: {
        label: item.label,
        description: 'before',
        kind: 'token',
        notes: 'kept note',
        secret: 'second-secret',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(response.status()).toBe(200);

    const revealed = await request.get(`/api/vault/items/${item.id}`, { headers: bearer(session.sessionToken) });
    const body = (await revealed.json()) as { item: { secret: string | null; healthStatus: string } };
    expect(body.item.secret).toBe('second-secret');
    expect(body.item.healthStatus).toBe('unchecked');
  });

  test('an edit with a wrong confirmation code is refused and changes nothing', async ({ request }) => {
    const session = await createGuest(request);
    const item = await createItem(request, session.sessionToken);

    // A missing code would pass here: creating the item opened the two-minute window.
    const response = await request.patch(`/api/vault/items/${item.id}`, {
      headers: bearer(session.sessionToken),
      data: { label: 'hijacked', description: 'after', kind: 'token', notes: 'kept note', confirmSecret: 'not-the-code' },
    });
    expect(response.status()).toBe(403);

    const revealed = await request.get(`/api/vault/items/${item.id}`, { headers: bearer(session.sessionToken) });
    const body = (await revealed.json()) as { item: { label: string } };
    expect(body.item.label).toBe(item.label);
  });
});
