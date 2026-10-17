/**
 * Bulk paste import for the vault cabinet.
 *
 * The dashboard's "Paste many" box posts LABEL=secret lines to one gated route.
 * These tests hold the two properties the batch depends on: one gate covers the
 * whole batch, and a malformed line rejects the batch without inserting
 * anything. The last test drives the same path through the UI with one typed
 * code.
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
    data: { displayName: `Vault Bulk ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function labels(request: APIRequestContext, token: string): Promise<string[]> {
  const response = await request.get('/api/vault/items', { headers: bearer(token) });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ label: string }> };
  return body.items.map((item) => item.label);
}

test.describe('vault bulk import', () => {
  test('one gated call stores one item per line', async ({ request }) => {
    const session = await createGuest(request);
    const first = `CF ${randomUUID().slice(0, 8)}`;
    const second = `GH ${randomUUID().slice(0, 8)}`;

    const response = await request.post('/api/vault/items/bulk', {
      headers: bearer(session.sessionToken),
      data: {
        lines: [`${first}=cf-secret`, `${second}=ghp_secret`],
        kind: 'token',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(response.status()).toBe(201);
    expect(((await response.json()) as { inserted: number }).inserted).toBe(2);

    const stored = await labels(request, session.sessionToken);
    expect(stored).toEqual(expect.arrayContaining([first, second]));
  });

  test('a malformed line rejects the whole paste and inserts nothing', async ({ request }) => {
    const session = await createGuest(request);
    const good = `Good ${randomUUID().slice(0, 8)}`;

    const response = await request.post('/api/vault/items/bulk', {
      headers: bearer(session.sessionToken),
      data: {
        lines: [`${good}=value`, 'this line has no separator'],
        kind: 'token',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('Line 2');

    expect(await labels(request, session.sessionToken)).toEqual([]);
  });

  test('the paste infers each line kind and the health pass leaves inferred rows alone', async ({ request }) => {
    const session = await createGuest(request);
    const suffix = randomUUID().slice(0, 8);
    const urlLabel = `SOME_${suffix}_API_URL`;
    const keyLabel = `SOME_${suffix}_API_KEY`;
    const modelLabel = `SOME_${suffix}_MODEL`;

    const created = await request.post('/api/vault/items/bulk', {
      headers: bearer(session.sessionToken),
      data: {
        lines: [
          `${urlLabel}=https://api.example.com/v1`,
          `${keyLabel}=sk-secret`,
          `${modelLabel}=gpt-5`,
        ],
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(created.status()).toBe(201);

    const health = await request.post('/api/vault/health', {
      headers: bearer(session.sessionToken),
      data: { confirmSecret: CONFIRM_SECRET },
    });
    expect(health.status()).toBe(200);
    expect(((await health.json()) as { purged: number }).purged).toBe(0);

    const response = await request.get('/api/vault/items', { headers: bearer(session.sessionToken) });
    const items = ((await response.json()) as {
      items: Array<{ label: string; kind: string; url: string | null; healthStatus: string }>;
    }).items;
    const byLabel = new Map(items.map((item) => [item.label, item]));
    expect(byLabel.get(urlLabel)).toMatchObject({
      kind: 'url',
      url: 'https://api.example.com/v1',
      healthStatus: 'unchecked',
    });
    expect(byLabel.get(keyLabel)?.kind).toBe('token');
    expect(byLabel.get(modelLabel)?.kind).toBe('note');
  });

  test('a paste over the line cap is refused', async ({ request }) => {
    const session = await createGuest(request);
    const lines = Array.from({ length: 201 }, (_, index) => `Key ${index}=value-${index}`);

    const response = await request.post('/api/vault/items/bulk', {
      headers: bearer(session.sessionToken),
      data: { lines, kind: 'token', confirmSecret: CONFIRM_SECRET },
    });
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('BULK_TOO_LARGE');
  });

  test('the dashboard imports a paste with one typed code, then filters the list', async ({ page }) => {
    const first = `Alpha ${randomUUID().slice(0, 8)}`;
    const second = `Beta ${randomUUID().slice(0, 8)}`;

    await page.goto('/');
    await page.getByTestId('login-guest').click();
    await expect(page.getByTestId('app-nav')).toBeVisible();
    await page.getByRole('button', { name: 'Keys', exact: true }).click();
    await expect(page.getByTestId('view-vault')).toBeVisible();

    await page.getByTestId('vault-account-bulk-toggle').click();
    await page.getByTestId('vault-account-bulk').fill(`${first}=one\n${second}=two`);
    await typeConfirmCode(page);
    await page.getByTestId('vault-account-bulk-import').click();

    // The grouped view renders each label in the sidebar chip, the group header,
    // and the row paragraph; the row paragraph is the unique per-key target.
    const rowLabel = (label: string) =>
      page.getByTestId('vault-account-items').locator('p').filter({ hasText: label });
    await expect(rowLabel(first)).toBeVisible();
    await expect(rowLabel(second)).toBeVisible();

    await page.getByTestId('vault-account-filter').fill('Alpha');
    await expect(rowLabel(first)).toBeVisible();
    await expect(rowLabel(second)).toHaveCount(0);
  });
});
