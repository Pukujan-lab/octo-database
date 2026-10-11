import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('uploads an arbitrary file and downloads identical bytes from the catalog', async ({ page }) => {
  const fileName = `catalog-${randomUUID()}.bin`;
  const sourcePath = join(tmpdir(), fileName);
  const sourceBytes = Buffer.from([0, 1, 127, 128, 254, 255]);
  writeFileSync(sourcePath, sourceBytes);

  try {
    await page.goto('/');
    await page.getByText('Continue as Guest').click();
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('[data-testid="file-upload"]').setInputFiles(sourcePath);
    const fileRow = page.getByRole('row').filter({ hasText: fileName });
    await expect(fileRow).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await fileRow.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(fileName);
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    expect(readFileSync(downloadedPath!)).toEqual(sourceBytes);
  } finally {
    unlinkSync(sourcePath);
  }
});
