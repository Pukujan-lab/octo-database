import { expect, test } from '@playwright/test';
import { typeConfirmCode } from './confirm-secret';

test('edits one key allowance without minting a new secret', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();

  await page.getByRole('button', { name: 'Mint a key' }).first().click();
  const dialog = page.locator('[data-testid="key-mint-form"]');
  await expect(dialog).toBeVisible();
  await page.locator('#key-name').fill('Allowance Agent');
  await typeConfirmCode(page);
  await page.getByRole('button', { name: 'Mint key' }).click();
  await expect(page.locator('[data-testid="one-time-secret"]')).toBeVisible();

  // The allowance editor is collapsed behind a Radix collapsible; open it
  // before editing. The key row's editor is scoped to its row so multiple
  // editors never collide.
  const editor = page.locator('table tbody tr').filter({ hasText: 'Allowance Agent' });
  await editor.getByRole('button', { name: /edit/ }).click();
  const deletion = editor.locator('input[id$="-scope-delete"]');
  await expect(deletion).not.toBeChecked();
  // The checkbox itself is visually hidden (sr-only); the visible label is the
  // click target a person uses.
  await editor.locator('label:has(input[id$="-scope-delete"])').click();
  await typeConfirmCode(page);
  await editor.getByRole('button', { name: 'Save allowances' }).click();

  // The save confirms via a toast, and the editor reflects the new set.
  await expect(page.getByText(`Allowances updated for Allowance Agent`)).toBeVisible();
  await editor.getByRole('button', { name: /edit/ }).click();
  await expect(editor.locator('input[id$="-scope-delete"]')).toBeChecked();
  await expect(editor.locator('input[id$="-scope-read"]')).toBeChecked();
  await expect(page.locator('[data-testid="one-time-secret"]')).toHaveCount(1);
});
