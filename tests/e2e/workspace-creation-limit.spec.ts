/**
 * Playwright E2E: Workspace-creation daily limit (Slice 16, issue #124)
 *
 * After Slice 15 stamps creation with a human confirmation secret, a second,
 * independent guard bounds spam: a non-owner principal may create at most one
 * workspace per rolling day. The platform owner is exempt. The auto-provisioned
 * personal sandbox a principal receives at sign-in must not consume the quota.
 *
 * Public deterministic evals cover the accepted user job and the window; the
 * per-principal and owner-exemption checks are the slice's targeted metamorphic
 * properties (change the acting principal / the owner flag, same claim holds).
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { queryService } from '../../src/server/db';
import { CONFIRM_SECRET, setConfirmSecret, typeConfirmCode } from './confirm-secret';

interface GuestSession {
  principal: { id: string; isGuest: boolean };
  workspace: { id: string };
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Limit E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

function createWorkspace(request: APIRequestContext, sessionToken: string, name: string) {
  return request.post('/api/workspaces', {
    headers: bearer(sessionToken),
    data: { name, confirmSecret: CONFIRM_SECRET },
  });
}

test.describe('Workspace creation daily limit', () => {
  test('a non-owner may create one workspace per day, then is refused until the window passes', async ({
    request,
  }) => {
    const owner = await createGuest(request);

    const first = await createWorkspace(request, owner.sessionToken, `Daily First ${randomUUID()}`);
    expect(first.status()).toBe(201);

    const second = await createWorkspace(request, owner.sessionToken, `Daily Second ${randomUUID()}`);
    expect(second.status()).toBe(429);
    expect((await second.json()).error).toMatch(/WORKSPACE_DAILY_LIMIT/);

    // The window is rolling: once the first creation is more than a day old it
    // no longer counts, so the same principal may create again. Backdate it
    // rather than waiting a day.
    await queryService(
      `UPDATE octo.workspaces SET created_at = now() - interval '25 hours'
       WHERE created_by = $1 AND auto_provisioned = false`,
      [owner.principal.id]
    );

    const third = await createWorkspace(request, owner.sessionToken, `Daily Third ${randomUUID()}`);
    expect(third.status()).toBe(201);
  });

  test('the refusal is shown in the create modal', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    // Guest login kicks off an async workspace load that re-renders the whole
    // app; opening the modal before it settles lets that render wipe the modal's
    // inputs. Wait for the network to go quiet so the app is idle first.
    await page.waitForLoadState('networkidle');

    const newWorkspace = page.getByRole('button', { name: 'New Workspace', exact: true });
    const dialog = page.getByRole('dialog');

    // First creation succeeds through the UI. The minted workspace key is shown
    // once inside the still-open dialog, so dismiss it before closing.
    await newWorkspace.click();
    await expect(dialog.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await dialog.locator('#ws-name').fill(`UI First ${Date.now()}`);
    await typeConfirmCode(page, dialog);
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    const secret = dialog.locator('[data-testid="one-time-secret"]');
    await expect(secret).toBeVisible();
    await expect(secret.getByText('Workspace key', { exact: true })).toBeVisible();
    await secret.getByRole('button', { name: 'Dismiss' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Second creation within the same day is refused, and the modal says so.
    await newWorkspace.click();
    await expect(dialog.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await dialog.locator('#ws-name').fill(`UI Second ${Date.now()}`);
    await typeConfirmCode(page, dialog);
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(
      page.getByText('This account has used its workspace allowance for today'),
    ).toBeVisible();
  });

  // Metamorphic: change the acting principal; the claim (one per day) holds per
  // principal, so one principal's creation must not consume another's quota.
  test('the quota is per-principal: one principal creating does not consume another\'s', async ({
    request,
  }) => {
    const a = await createGuest(request);
    const b = await createGuest(request);

    expect((await createWorkspace(request, a.sessionToken, `Indep A ${randomUUID()}`)).status()).toBe(201);
    expect((await createWorkspace(request, b.sessionToken, `Indep B ${randomUUID()}`)).status()).toBe(201);
  });

  // Metamorphic: change the owner flag; the exemption means the count no longer
  // applies, so two creations in the same window both succeed.
  test('the platform owner is never limited', async ({ request }) => {
    const owner = await createGuest(request);
    await queryService('UPDATE octo.principals SET is_platform_owner = true WHERE id = $1', [
      owner.principal.id,
    ]);

    expect((await createWorkspace(request, owner.sessionToken, `Owner One ${randomUUID()}`)).status()).toBe(201);
    expect((await createWorkspace(request, owner.sessionToken, `Owner Two ${randomUUID()}`)).status()).toBe(201);
  });
});
