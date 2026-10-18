/**
 * Keys page: revealing and editing a stored key.
 *
 * `Show` must put the secret where the person clicked, not at the top of a page
 * they have scrolled past. `Edit` must open a prefilled dialog that saves
 * through the PATCH endpoint, keeping the stored secret when the field is left
 * blank.
 */

import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { typeConfirmCode } from './confirm-secret';

async function openCabinet(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-guest').click();
  await expect(page.getByTestId('app-nav')).toBeVisible();
  await page.getByRole('button', { name: 'Keys', exact: true }).click();
  await expect(page.getByTestId('view-vault')).toBeVisible();
}

/** One key with a secret and notes, created through the UI's bulk paste. */
async function seedKey(page: Page, label: string): Promise<void> {
  await page.getByTestId('vault-account-bulk-toggle').click();
  await page.getByTestId('vault-account-bulk').fill(`${label}=sk-test-value`);
  await typeConfirmCode(page);
  await page.getByTestId('vault-account-bulk-import').click();
  await expect(page.getByTestId('vault-account-items').locator('p').filter({ hasText: label })).toBeVisible();
}

function rowFor(page: Page, label: string) {
  return page
    .getByTestId('vault-account-items')
    .locator('tr')
    .filter({ has: page.locator('p', { hasText: label }) });
}

test.describe('keys page reveal and edit', () => {
  test('Show reveals the secret in the row that was clicked, on screen', async ({ page }) => {
    const label = `Reveal ${randomUUID().slice(0, 8)}`;
    await openCabinet(page);
    await seedKey(page, label);

    const row = rowFor(page, label);
    await row.getByRole('button', { name: `Actions for ${label}` }).click();
    await page.getByRole('menuitem', { name: 'Show' }).click();

    const secret = page.locator('[data-testid="one-time-secret"]');
    await expect(secret).toHaveCount(1);
    await expect(secret).toBeInViewport();
    await expect(secret).toContainText('sk-test-value');

    // It opens directly under the row that was clicked, not at the top of the page.
    const rowBox = await row.boundingBox();
    const secretBox = await secret.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(secretBox).not.toBeNull();
    expect(secretBox!.y).toBeGreaterThanOrEqual(rowBox!.y);
    expect(secretBox!.y - (rowBox!.y + rowBox!.height)).toBeLessThan(80);
  });

  test('Edit saves changed fields and keeps the secret when the field is blank', async ({ page }) => {
    const label = `Edit ${randomUUID().slice(0, 8)}`;
    await openCabinet(page);
    await seedKey(page, label);

    // Arm the gate before the edit dialog opens: the gate's trigger sits behind
    // the modal once it is up.
    await typeConfirmCode(page);

    const row = rowFor(page, label);
    await row.getByRole('button', { name: `Actions for ${label}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();

    const dialog = page.getByTestId('vault-edit-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#vault-edit-label')).toHaveValue(label);
    await expect(page.locator('#vault-edit-secret')).toHaveValue('');

    await page.locator('#vault-edit-description').fill('edited by the test');
    await page.getByTestId('vault-edit-save').click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId('vault-account-items').locator('p').filter({ hasText: 'edited by the test' })).toBeVisible();

    // The stored secret survived the edit with a blank secret field.
    await row.getByRole('button', { name: `Actions for ${label}` }).click();
    await page.getByRole('menuitem', { name: 'Show' }).click();
    await expect(page.locator('[data-testid="one-time-secret"]')).toContainText('sk-test-value');
  });

  test('a long URL does not push the page or the Key column sideways', async ({ page }) => {
    const label = `Url ${randomUUID().slice(0, 8)}`;
    const longUrl = `https://${'bucket-name-'.repeat(12)}r2.cloudflarestorage.com/${'deep/path/'.repeat(8)}`;

    await openCabinet(page);
    // One cabinet only, so the form's labels are unambiguous.
    await page.getByRole('button', { name: 'Account', exact: true }).click();

    await page.getByPlaceholder('Cloudflare').fill(label);
    await page.locator('#vault-account-description').fill('a very long endpoint');
    await page.locator('#vault-account-secret').fill('url-secret');
    await page.getByPlaceholder('https://').fill(longUrl);
    await typeConfirmCode(page);
    await page.getByRole('button', { name: 'Save key' }).click();

    await expect(page.getByTestId('vault-account-items').locator('p').filter({ hasText: label })).toBeVisible();

    const metrics = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="vault-account-items"] table');
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        tableWidth: table?.scrollWidth ?? 0,
        tableClient: table?.clientWidth ?? 0,
      };
    });
    expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.tableWidth).toBeLessThanOrEqual(metrics.tableClient);
  });
});
