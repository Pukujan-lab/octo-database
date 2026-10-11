/**
 * Playwright E2E: Workspace Gallery (Slice 3)
 *
 * Proves the gallery's core contract: the grid loads small cached thumbnail
 * derivatives while the lightbox loads the full-resolution original, and media
 * routes reject unsigned cross-workspace access.
 */

import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_WIDTH = 1000;
const ORIGINAL_HEIGHT = 700;

async function makePng(path: string, rgb: { r: number; g: number; b: number }): Promise<void> {
  const buf = await sharp({
    create: { width: ORIGINAL_WIDTH, height: ORIGINAL_HEIGHT, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
  writeFileSync(path, buf);
}

test.describe('Workspace Gallery', () => {
  test('grid loads thumbnail derivatives while the lightbox loads the original', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    // Upload a real image through the file input.
    const photo = join(tmpdir(), 'gallery-e2e-photo.png');
    await makePng(photo, { r: 200, g: 60, b: 40 });
    await page.locator('[data-testid="file-upload"]').setInputFiles(photo);
    await expect(page.getByText('gallery-e2e-photo.png').first()).toBeVisible();
    await page.getByRole('button', { name: 'Gallery', exact: true }).click();

    // Grid thumbnail must resolve to a small derivative, not the original.
    const thumb = page.locator('img[alt="gallery-e2e-photo.png"]');
    await expect(thumb).toBeVisible();
    await page.waitForFunction(
      () => {
        const img = document.querySelector('img[alt="gallery-e2e-photo.png"]') as HTMLImageElement | null;
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 30000 }
    );

    const thumbDims = await thumb.evaluate((el) => {
      const img = el as HTMLImageElement;
      return { w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') ?? '' };
    });

    expect(thumbDims.src).toContain('/api/files/thumbnail');
    expect(thumbDims.src).toContain('sig=');
    expect(Math.max(thumbDims.w, thumbDims.h)).toBeLessThanOrEqual(400);
    expect(thumbDims.w).toBeLessThan(ORIGINAL_WIDTH);

    // Opening the item must load the full-resolution original.
    await thumb.click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.waitForFunction(
      () => {
        const img = document.querySelector('[role="dialog"] img') as HTMLImageElement | null;
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 30000 }
    );

    const fullDims = await page.locator('[role="dialog"] img').evaluate((el) => {
      const img = el as HTMLImageElement;
      return { w: img.naturalWidth, h: img.naturalHeight };
    });

    expect(fullDims.w).toBe(ORIGINAL_WIDTH);
    expect(fullDims.h).toBe(ORIGINAL_HEIGHT);
  });

  test('media routes reject unsigned and tampered requests', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    // No credential at all -> unauthenticated.
    const unsigned = await page.request.get('/api/files/thumbnail?fileId=x&workspaceId=y');
    expect(unsigned.status()).toBe(401);

    // Forged signature -> still rejected.
    const forged = await page.request.get(
      '/api/files/thumbnail?fileId=x&workspaceId=y&principalId=z&exp=9999999999&sig=deadbeef'
    );
    expect(forged.status()).toBe(401);
  });
});
