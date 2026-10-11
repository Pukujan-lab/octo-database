/**
 * Playwright E2E: MFA (TOTP) step-up for workspace creation and key minting
 * (Slice 18, issue #126)
 *
 * Slice 17 added a per-principal TOTP step-up to the destructive-command gate and
 * wired it into deletion. This slice applies the same check to the two other
 * human-stamped operations — workspace creation and API-key minting — so an
 * MFA-enabled principal must present a current code (or a one-time recovery
 * code) for all three. Non-enrolled principals and API-key callers are
 * unaffected, exactly as before.
 *
 * Public deterministic evals cover the accepted job (secret alone is refused,
 * code completes both operations). The non-enrolled and API-key checks are the
 * slice's targeted metamorphic properties.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { generateSync } from 'otplib/functional';
import { CONFIRM_SECRET, setConfirmSecret, typeConfirmCode } from './confirm-secret';

interface GuestSession {
  principal: { id: string; isGuest: boolean };
  workspace: { id: string; slug: string };
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `MFA Create E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function enrollMfa(
  request: APIRequestContext,
  sessionToken: string
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const begin = await request.post('/api/me/mfa/begin', { headers: bearer(sessionToken) });
  expect(begin.status()).toBe(200);
  const { secret } = (await begin.json()) as { secret: string };
  const confirm = await request.post('/api/me/mfa/confirm', {
    headers: bearer(sessionToken),
    data: { code: generateSync({ secret }) },
  });
  expect(confirm.status()).toBe(200);
  const { recoveryCodes } = (await confirm.json()) as { recoveryCodes: string[] };
  return { secret, recoveryCodes };
}

function createWorkspace(request: APIRequestContext, sessionToken: string, extra: Record<string, unknown> = {}) {
  return request.post('/api/workspaces', {
    headers: bearer(sessionToken),
    data: { name: `MFA Create ${randomUUID()}`, confirmSecret: CONFIRM_SECRET, ...extra },
  });
}

function mintKey(
  request: APIRequestContext,
  sessionToken: string,
  workspaceId: string,
  extra: Record<string, unknown> = {}
) {
  return request.post('/api/keys', {
    headers: bearer(sessionToken),
    data: {
      name: `MFA Key ${randomUUID()}`,
      workspaceId,
      scopes: ['read', 'write', 'files', 'delete'],
      confirmSecret: CONFIRM_SECRET,
      ...extra,
    },
  });
}

test.describe('MFA step-up for creation and minting', () => {
  test('an MFA-enabled principal cannot create or mint with the secret alone, but can with a code', async ({
    request,
  }) => {
    const session = await createGuest(request);
    const { secret } = await enrollMfa(request, session.sessionToken);

    // Secret only: both stamped operations are refused for the missing code.
    const createWithoutCode = await createWorkspace(request, session.sessionToken);
    expect(createWithoutCode.status()).toBe(403);
    expect((await createWithoutCode.json()).error).toMatch(/MFA_CODE_INVALID/);

    const mintWithoutCode = await mintKey(request, session.sessionToken, session.workspace.id);
    expect(mintWithoutCode.status()).toBe(403);
    expect((await mintWithoutCode.json()).error).toMatch(/MFA_CODE_INVALID/);

    // A valid current code completes both.
    const createWithCode = await createWorkspace(request, session.sessionToken, {
      mfaCode: generateSync({ secret }),
    });
    expect(createWithCode.status()).toBe(201);

    const mintWithCode = await mintKey(request, session.sessionToken, session.workspace.id, {
      mfaCode: generateSync({ secret }),
    });
    expect(mintWithCode.status()).toBe(201);
  });

  // Metamorphic: change the enrollment state. A principal without MFA creates
  // and mints with the secret alone, exactly as before this slice.
  test('a principal without MFA enrolled creates and mints with the secret alone', async ({
    request,
  }) => {
    const session = await createGuest(request);
    expect((await createWorkspace(request, session.sessionToken)).status()).toBe(201);
    expect((await mintKey(request, session.sessionToken, session.workspace.id)).status()).toBe(201);
  });

  // Metamorphic: change the credential class. An API key is refused before any
  // MFA check, for creation and minting alike.
  test('an API-key caller remains refused for creation and minting', async ({ request }) => {
    const session = await createGuest(request);
    const minted = await mintKey(request, session.sessionToken, session.workspace.id);
    expect(minted.status()).toBe(201);
    const { rawSecret } = (await minted.json()) as { rawSecret: string };

    const createRes = await request.post('/api/workspaces', {
      headers: bearer(rawSecret),
      data: { name: `Key Create ${randomUUID()}`, confirmSecret: 'anything', mfaCode: '000000' },
    });
    expect(createRes.status()).toBe(403);
    expect((await createRes.json()).error).toMatch(/FORBIDDEN/);

    const mintRes = await request.post('/api/keys', {
      headers: bearer(rawSecret),
      data: { name: 'key mint', confirmSecret: 'anything', mfaCode: '000000' },
    });
    expect(mintRes.status()).toBe(403);
    expect((await mintRes.json()).error).toMatch(/FORBIDDEN/);
  });

  test('the create modal asks for a code once MFA is enabled', async ({ page, request }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Enroll through the API on the same session, then reload so the dashboard
    // knows MFA is enabled and renders the code field.
    const token = await page.evaluate(() => localStorage.getItem('octo_token')!);
    await setConfirmSecret(request, token);
    const { secret } = await enrollMfa(request, token);
    await page.reload();
    await page.waitForLoadState('networkidle');

    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'New Workspace', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await dialog.locator('#ws-name').fill(`UI MFA Create ${Date.now()}`);
    await dialog.locator('[data-testid="mfa-code"]').fill(generateSync({ secret }));
    await typeConfirmCode(page, dialog);
    await dialog.getByRole('button', { name: 'Create workspace' }).click();

    // Creation shows the one-time workspace key inside the still-open dialog.
    await expect(dialog.locator('[data-testid="one-time-secret"]')).toBeVisible();
  });
});
