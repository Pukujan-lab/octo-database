/**
 * Bulk delete for the vault cabinet.
 *
 * Selecting several keys and deleting them is one gated call: the same
 * single-use confirmation code covers the whole batch, a refused code deletes
 * nothing, and ids outside the caller's cabinet are not touched.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret, typeConfirmCode } from './confirm-secret';

interface GuestSession {
  workspace: { id: string };
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Vault Bulk Delete ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function store(
  request: APIRequestContext,
  token: string,
  label: string
): Promise<string> {
  const response = await request.post('/api/vault/items', {
    headers: bearer(token),
    data: {
      label,
      description: `${label} key.`,
      kind: 'token',
      secret: `sk-${randomUUID()}`,
      confirmSecret: CONFIRM_SECRET,
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { item: { id: string } }).item.id;
}

async function labels(request: APIRequestContext, token: string): Promise<string[]> {
  const response = await request.get('/api/vault/items', { headers: bearer(token) });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ label: string }> };
  return body.items.map((item) => item.label);
}

test.describe('vault bulk delete', () => {
  test('one gated call deletes the selected keys and leaves the rest', async ({ request }) => {
    const session = await createGuest(request);
    const keep = `Keep ${randomUUID().slice(0, 8)}`;
    const dropOne = `Drop ${randomUUID().slice(0, 8)}`;
    const dropTwo = `Drop ${randomUUID().slice(0, 8)}`;

    const keepId = await store(request, session.sessionToken, keep);
    const firstId = await store(request, session.sessionToken, dropOne);
    const secondId = await store(request, session.sessionToken, dropTwo);

    const deleted = await request.post('/api/vault/items/bulk-delete', {
      headers: bearer(session.sessionToken),
      data: { ids: [firstId, secondId], confirmSecret: CONFIRM_SECRET },
    });
    expect(deleted.status()).toBe(200);
    expect(((await deleted.json()) as { deleted: number }).deleted).toBe(2);

    const remaining = await labels(request, session.sessionToken);
    expect(remaining).toEqual([keep]);
    expect(remaining).not.toContain(dropOne);
    expect(remaining).not.toContain(dropTwo);

    const stillThere = await request.get(`/api/vault/items/${keepId}`, {
      headers: bearer(session.sessionToken),
    });
    expect(stillThere.status()).toBe(200);
  });

  test('a missing or wrong code deletes nothing', async ({ request }) => {
    const session = await createGuest(request);
    const label = `Guarded ${randomUUID().slice(0, 8)}`;
    const id = await store(request, session.sessionToken, label);

    const missing = await request.post('/api/vault/items/bulk-delete', {
      headers: bearer(session.sessionToken),
      data: { ids: [id] },
    });
    expect(missing.status()).toBe(403);

    const wrong = await request.post('/api/vault/items/bulk-delete', {
      headers: bearer(session.sessionToken),
      data: { ids: [id], confirmSecret: 'not-the-code' },
    });
    expect(wrong.status()).toBe(403);

    expect(await labels(request, session.sessionToken)).toContain(label);
  });

  test('ids outside the caller cabinet are ignored and malformed ids are refused', async ({ request }) => {
    const owner = await createGuest(request);
    const other = await createGuest(request);
    const label = `Owner ${randomUUID().slice(0, 8)}`;
    const id = await store(request, owner.sessionToken, label);
    const foreign = await store(request, other.sessionToken, `Other ${randomUUID().slice(0, 8)}`);

    const mixed = await request.post('/api/vault/items/bulk-delete', {
      headers: bearer(owner.sessionToken),
      data: { ids: [id, foreign], confirmSecret: CONFIRM_SECRET },
    });
    expect(mixed.status()).toBe(200);
    expect(((await mixed.json()) as { deleted: number }).deleted).toBe(1);
    expect(await labels(request, owner.sessionToken)).not.toContain(label);
    expect(await labels(request, other.sessionToken)).toHaveLength(1);

    const malformed = await request.post('/api/vault/items/bulk-delete', {
      headers: bearer(owner.sessionToken),
      data: { ids: ['not-a-uuid'], confirmSecret: CONFIRM_SECRET },
    });
    expect(malformed.status()).toBe(400);

    const empty = await request.post('/api/vault/items/bulk-delete', {
      headers: bearer(owner.sessionToken),
      data: { ids: [], confirmSecret: CONFIRM_SECRET },
    });
    expect(empty.status()).toBe(400);
  });

  test('the dashboard checks two rows, deletes them with one typed code, and clears the bar', async ({
    page,
  }) => {
    const first = `Alpha ${randomUUID().slice(0, 8)}`;
    const second = `Beta ${randomUUID().slice(0, 8)}`;
    const keep = `Gamma ${randomUUID().slice(0, 8)}`;

    await page.goto('/');
    await page.getByTestId('login-guest').click();
    await expect(page.getByTestId('app-nav')).toBeVisible();
    await page.getByRole('button', { name: 'Keys', exact: true }).click();
    await expect(page.getByTestId('view-vault')).toBeVisible();

    await page.getByTestId('vault-account-bulk-toggle').click();
    await page.getByTestId('vault-account-bulk').fill(`${first}=one\n${second}=two\n${keep}=three`);
    await typeConfirmCode(page);
    await page.getByTestId('vault-account-bulk-import').click();

    const rowLabel = (label: string) =>
      page.getByTestId('vault-account-items').locator('p').filter({ hasText: label });
    await expect(rowLabel(first)).toBeVisible();

    await page.getByRole('checkbox', { name: `Select ${first}` }).check();
    await page.getByRole('checkbox', { name: `Select ${second}` }).check();
    await expect(page.getByTestId('vault-bulk-count')).toContainText('2');

    // Typing the code first arms the gate; the delete then goes through in one click.
    await typeConfirmCode(page);
    await page.getByTestId('vault-bulk-delete').click();

    await expect(rowLabel(first)).toHaveCount(0);
    await expect(rowLabel(second)).toHaveCount(0);
    await expect(rowLabel(keep)).toBeVisible();
    await expect(page.getByTestId('vault-bulk-bar')).toHaveCount(0);
  });
});
