/**
 * Playwright E2E: Scoped Share Links (Slice 4)
 *
 * Proves the share boundary end to end in a real browser: a logged-out recipient
 * sees only the shared album, and revoking the link takes effect immediately.
 */

import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test.describe('Scoped Share Links', () => {
  test('logged-out recipient views only the shared album, and revocation is immediate', async ({
    page,
    context,
  }) => {
    // --- Owner signs in, uploads media, and creates a read-only share ---
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    const photo = join(tmpdir(), 'share-e2e-photo.png');
    writeFileSync(
      photo,
      await sharp({
        create: { width: 900, height: 600, channels: 3, background: { r: 60, g: 130, b: 200 } },
      })
        .png()
        .toBuffer()
    );
    await page.locator('[data-testid="file-upload"]').setInputFiles(photo);
    await expect(page.getByText('share-e2e-photo.png').first()).toBeVisible();

    await page.getByRole('button', { name: 'Access', exact: true }).click();
    // "Share links" is a substring of the empty state's "No share links".
    await expect(page.getByRole('heading', { name: 'Share links', exact: true })).toBeVisible();
    // The toolbar and the empty state both offer "Create link"; the toolbar is first.
    await page.getByRole('button', { name: 'Create link' }).first().click();
    await expect(page.getByText('Share URL')).toBeVisible();

    const shareUrl = await page.locator('[data-testid="one-time-secret"] p.num').first().innerText();
    const token = shareUrl.trim().split('/share/')[1];
    expect(token).toBeTruthy();
    expect(token.startsWith('octo_share_')).toBe(true);

    // --- A logged-out recipient opens the link in a clean context ---
    const recipient = await context.browser()!.newContext();
    const recipientPage = await recipient.newPage();
    await recipientPage.goto(`/share/${token}`);

    await expect(recipientPage.getByRole('heading', { name: /read-only/ })).toBeVisible();
    await expect(recipientPage.getByText('read', { exact: true })).toBeVisible();

    // The recipient sees the shared media...
    const sharedThumb = recipientPage.locator('img[alt="share-e2e-photo.png"]');
    await expect(sharedThumb).toBeVisible();
    await recipientPage.waitForFunction(
      () => {
        const img = document.querySelector(
          'img[alt="share-e2e-photo.png"]'
        ) as HTMLImageElement | null;
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 30000 }
    );

    // ...but no workspace, member, key, or admin surface is reachable.
    await expect(recipientPage.locator('[data-testid="app-nav"]')).toHaveCount(0);
    await expect(recipientPage.getByText('API keys', { exact: false })).toHaveCount(0);
    await expect(recipientPage.getByText('File catalog', { exact: false })).toHaveCount(0);

    const workspaceProbe = await recipientPage.request.get('/api/workspaces');
    expect(workspaceProbe.status()).toBe(401);
    const keyProbe = await recipientPage.request.get('/api/keys');
    expect(keyProbe.status()).toBe(401);

    // --- Owner revokes; the recipient's access dies immediately ---
    await page.getByRole('button', { name: /^Actions for share / }).click();
    await page.getByRole('menuitem', { name: 'Revoke' }).click();
    await expect(page.getByText('Revoked')).toBeVisible();

    const afterRevoke = await recipientPage.request.get(`/api/public/shares/${token}`);
    expect(afterRevoke.status()).toBe(404);

    await recipientPage.reload();
    await expect(recipientPage.getByText('This link is not available')).toBeVisible();

    await recipient.close();
  });

  test('unknown tokens and admin routes are unreachable anonymously', async ({ page }) => {
    await page.goto('/share/octo_share_does_not_exist');
    await expect(page.getByText('This link is not available')).toBeVisible();

    expect((await page.request.get('/api/workspaces/shares?workspaceId=x')).status()).toBe(401);
    expect((await page.request.get('/api/public/shares/octo_share_nope')).status()).toBe(404);
  });
});
