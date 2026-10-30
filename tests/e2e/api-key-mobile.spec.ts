import { expect, test, type Locator } from '@playwright/test';
import { typeConfirmCode } from './confirm-secret';

test('keeps API key creation and the new secret on a phone screen', async ({ page }) => {
  const viewport = { width: 390, height: 700 };
  await page.setViewportSize(viewport);
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();

  await page.getByRole('button', { name: 'Mint a key' }).first().click();
  const dialog = page.locator('[data-testid="key-mint-form"]');
  await expect(dialog).toBeVisible();

  const nameInput = page.locator('#key-name');
  const mintButton = page.getByRole('button', { name: 'Mint key' });
  await expect(nameInput).toBeVisible();
  await expect(mintButton).toBeVisible();
  // The form opens at the top. On a phone the confirm gate pushes Mint key
  // below the fold; a swipe of the dialog brings it fully on screen.
  await expectOnScreen(nameInput, viewport);
  await mintButton.scrollIntoViewIfNeeded();
  await expectOnScreen(mintButton, viewport);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await nameInput.fill('Phone Agent');
  await typeConfirmCode(page);
  await mintButton.click();

  const secret = page.locator('[data-testid="one-time-secret"]');
  await expect(secret).toBeVisible();
  // The secret card sits below the mint dialog and may start under the fold on
  // a phone — the design scrolls. Scrolled into view, the secret and its two
  // actions must be fully on screen, with no horizontal clipping.
  await secret.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  await expectOnScreen(secret.getByText(/^octo_live_ws_/), viewport);
  await expectOnScreen(secret.getByRole('button', { name: 'Copy to clipboard' }), viewport);
  await expectOnScreen(secret.getByRole('button', { name: 'Dismiss' }), viewport);
});

async function expectOnScreen(
  locator: Locator,
  viewport: { width: number; height: number },
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}
