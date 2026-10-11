/**
 * Playwright E2E & Vision: Workspace data plane (Slice 13)
 *
 * Exercises the workspace lifecycle in a real browser against the live server
 * and database, and asserts the metamorphic relations that only a running
 * system can show:
 *
 *   MR-1  Idempotent create: a duplicate create leaves exactly one workspace.
 *   MR-3  Workspace pinning: a workspace key cannot touch another workspace.
 *   MR-7  Confirmation gate: an API-key caller can never delete a workspace.
 *
 * Plus the golden path: create workspace -> auto-provisioned key shown ->
 * upload -> archive -> restore -> delete. The archive leg runs wherever the
 * cold tier is configured; where it is not (CI has no Drive credentials), the
 * route's documented 503 contract is asserted instead, so the test proves the
 * boundary either way.
 */

import { expect, Page, test } from '@playwright/test';
import { auditPage } from './vision-audit';
import { typeConfirmCode } from './confirm-secret';
import { exemptFromDailyLimit } from './workspace-quota';

/** Selects a workspace by name from the dashboard's workspace switcher. */
async function selectWorkspace(page: Page, name: string): Promise<void> {
  // The picker labels each option "<name> — /<slug>", so resolve the value first.
  const value = await page
    .locator('#workspace-picker option')
    .filter({ hasText: name })
    .first()
    .getAttribute('value');
  await page.locator('#workspace-picker').selectOption(value!);
}

test.describe('Workspace data plane', () => {
  test('create workspace, reveal its key, and drive a file through the tiers', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    // 1. Create a workspace from the UI; a key is auto-provisioned and shown once.
    await page.getByRole('button', { name: 'New Workspace', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    const wsName = `Lifecycle ${Date.now()}`;
    await dialog.locator('#ws-name').fill(wsName);
    await typeConfirmCode(page, dialog);
    await dialog.getByRole('button', { name: 'Create workspace' }).click();

    // 2. The one-time workspace key appears inside the still-open dialog, and the
    //    new workspace is already the active one.
    const keyNotice = dialog.locator('[data-testid="one-time-secret"]');
    await expect(keyNotice.getByText('Workspace key', { exact: true })).toBeVisible();
    await expect(keyNotice.getByText(/octo_live_ws_/)).toBeVisible();
    await expect(page.locator('h1')).toContainText(wsName);
    await keyNotice.getByRole('button', { name: 'Dismiss' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    const wsId = await page.evaluate(async (name: string) => {
      const token = localStorage.getItem('octo_token');
      const list = await (
        await fetch('/api/workspaces', { headers: { Authorization: `Bearer ${token}` } })
      ).json();
      return (list as { id: string; name: string }[]).find((w) => w.name === name)!.id;
    }, wsName);

    // 3. Switch to the new workspace and upload a file. Creating the workspace
    //    kicks off a background load that re-renders the whole app; opening the
    //    modal before it settles lets that render wipe the modal's inputs, so
    //    wait for the network to go quiet first.
    await selectWorkspace(page, wsName);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'New text file' }).click();
    const textDialog = page.getByRole('dialog');
    await textDialog.locator('#text-file-name').fill('lifecycle.txt');
    await textDialog.locator('#text-file-body').fill('round-trip payload');
    await textDialog.getByRole('button', { name: 'Create file' }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByText('lifecycle.txt', { exact: true })).toBeVisible();

    // 4. Archive it: queue the job and run the worker.
    const archiveStatus = await page.evaluate(async (workspaceId: string) => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const files = await (await fetch(`/api/files?workspaceId=${workspaceId}`, { headers })).json();
      const file = files.find((f: { name: string }) => f.name === 'lifecycle.txt');
      const res = await fetch(`/api/files/${file.id}/archive?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) return res.status;
      await fetch(`/api/jobs/run?workspaceId=${workspaceId}`, { method: 'POST', headers });
      return 202;
    }, wsId);

    if (archiveStatus === 202) {
      // Cold tier configured: the file moves to Drive and back. Reload first so
      // the workspace switcher resets to the guest workspace, making the
      // re-selection below fire a refresh of the new workspace's file list.
      await page.reload();
      await selectWorkspace(page, wsName);
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(page.getByText('Archived').first()).toBeVisible({ timeout: 30000 });

      const restoreStatus = await page.evaluate(async (workspaceId: string) => {
        const token = localStorage.getItem('octo_token');
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
        const files = await (await fetch(`/api/files?workspaceId=${workspaceId}`, { headers })).json();
        const file = files.find((f: { name: string }) => f.name === 'lifecycle.txt');
        const res = await fetch(`/api/files/${file.id}/restore?workspaceId=${workspaceId}`, {
          method: 'POST',
          headers,
        });
        await fetch(`/api/jobs/run?workspaceId=${workspaceId}`, { method: 'POST', headers });
        return res.status;
      }, wsId);
      expect(restoreStatus).toBe(202);

      await page.reload();
      await selectWorkspace(page, wsName);
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(page.getByText('Ready').first()).toBeVisible({ timeout: 30000 });
    } else {
      // Cold tier absent (CI): the route fails closed with a clear contract.
      expect(archiveStatus).toBe(503);
    }

    // 5. Vision audit of the workspace control surface with the new panels.
    const vision = await auditPage(page, 'Workspace Data Plane');
    if (vision) {
      expect(vision.passed).toBe(true);
      expect(vision.score).toBeGreaterThanOrEqual(75);
    }

    // 6. Delete the workspace through the confirmation-secret gate.
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    const settings = page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: 'Settings' }) });
    await settings.getByRole('button', { name: 'Delete workspace', exact: true }).click();

    const slug = await page.evaluate(async (workspaceId: string) => {
      const token = localStorage.getItem('octo_token');
      const list = await (
        await fetch('/api/workspaces', { headers: { Authorization: `Bearer ${token}` } })
      ).json();
      return (list as { id: string; slug: string }[]).find((w) => w.id === workspaceId)!.slug;
    }, wsId);
    const deleteSlug = settings.locator('#delete-slug');
    await expect(deleteSlug).toBeVisible();
    await deleteSlug.fill(slug);
    await typeConfirmCode(page, settings);
    await settings.getByRole('button', { name: `Delete ${wsName}` }).click();

    // The guest's personal workspace remains, so the app stays signed in and the
    // deleted workspace disappears from the picker.
    await expect(page.getByText(`Workspace ${slug} deleted`)).toBeVisible();
    await expect(page.locator('#workspace-picker option').filter({ hasText: wsName })).toHaveCount(0, {
      timeout: 15000,
    });
  });

  test('MR-1 idempotent create: a duplicate create leaves exactly one workspace', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await exemptFromDailyLimit(page);

    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      await fetch('/api/me/confirm-secret', {
        method: 'POST',
        headers,
        body: JSON.stringify({ secret: 'e2e-confirm-secret' }),
      });
      const name = `Idempotent ${Date.now()}`;
      const first = await (
        await fetch('/api/workspaces', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name, confirmSecret: 'e2e-confirm-secret' }),
        })
      ).json();
      const second = await fetch('/api/workspaces', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, confirmSecret: 'e2e-confirm-secret' }),
      });
      const list = (await (
        await fetch('/api/workspaces', { headers })
      ).json()) as { id: string; name: string }[];
      return {
        secondStatus: second.status,
        matches: list.filter((w) => w.id === first.workspace.id).length,
        totalWithName: list.filter((w) => w.name === name).length,
      };
    });

    expect(result.secondStatus).toBe(409);
    expect(result.matches).toBe(1);
    expect(result.totalWithName).toBe(1);
  });

  test('MR-3 & MR-7: a workspace key is pinned and can never delete a workspace', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await exemptFromDailyLimit(page);

    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      // Creation and minting are stamped: arm the gate from the human session.
      await fetch('/api/me/confirm-secret', {
        method: 'POST',
        headers,
        body: JSON.stringify({ secret: 'e2e-confirm-secret' }),
      });

      // Two workspaces: the key is minted for the first only.
      const a = await (
        await fetch('/api/workspaces', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: `Pinned A ${Date.now()}`, confirmSecret: 'e2e-confirm-secret' }),
        })
      ).json();
      const b = await (
        await fetch('/api/workspaces', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: `Pinned B ${Date.now()}`, confirmSecret: 'e2e-confirm-secret' }),
        })
      ).json();

      const minted = await (
        await fetch('/api/keys', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: 'pinned key',
            workspaceId: a.workspace.id,
            scopes: ['read', 'write', 'files', 'delete'],
            confirmSecret: 'e2e-confirm-secret',
          }),
        })
      ).json();
      const keyHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${minted.rawSecret}`,
      };

      // Pinning: the key reads its own workspace, never the other.
      const ownStatus = (
        await fetch(`/api/files?workspaceId=${a.workspace.id}`, { headers: keyHeaders })
      ).status;
      const otherStatus = (
        await fetch(`/api/files?workspaceId=${b.workspace.id}`, { headers: keyHeaders })
      ).status;

      // Confirmation gate: even with the delete scope, a key caller is refused.
      const deleteRes = await fetch(`/api/workspaces/${a.workspace.id}`, {
        method: 'DELETE',
        headers: keyHeaders,
        body: JSON.stringify({ confirmSecret: 'anything', confirmSlug: a.workspace.slug }),
      });

      // A malformed (empty) body must produce the same clean refusal, never a
      // 500 from parsing an absent payload.
      const deleteNoBodyRes = await fetch(`/api/workspaces/${a.workspace.id}`, {
        method: 'DELETE',
        headers: keyHeaders,
      });

      // The same key cannot create a workspace or mint another key: both carry
      // the human stamp, which an API key can never satisfy.
      const createRes = await fetch('/api/workspaces', {
        method: 'POST',
        headers: keyHeaders,
        body: JSON.stringify({ name: `Key Create ${Date.now()}`, confirmSecret: 'anything' }),
      });
      const mintRes = await fetch('/api/keys', {
        method: 'POST',
        headers: keyHeaders,
        body: JSON.stringify({ name: 'key mint', confirmSecret: 'anything' }),
      });

      return {
        ownStatus,
        otherStatus,
        deleteStatus: deleteRes.status,
        deleteBody: await deleteRes.json(),
        deleteNoBodyStatus: deleteNoBodyRes.status,
        createStatus: createRes.status,
        mintStatus: mintRes.status,
      };
    });

    expect(result.ownStatus).toBe(200);
    expect(result.otherStatus).toBe(403);
    expect(result.deleteStatus).toBe(403);
    expect(JSON.stringify(result.deleteBody)).toMatch(/human session|API keys can never/i);
    expect(result.deleteNoBodyStatus).toBe(403);
    // Create and mint are stamped the same way: an API key can never satisfy them.
    expect(result.createStatus).toBe(403);
    expect(result.mintStatus).toBe(403);
  });
});
