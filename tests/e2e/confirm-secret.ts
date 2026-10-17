/**
 * Shared E2E helper for the human confirmation gate.
 *
 * Creating a workspace, minting an API key, and deleting a workspace are all
 * stamped operations: they require a human session plus the confirmation secret
 * (Slice 15). A guest session is a human session (no API key), so a test that
 * drives these routes directly must arm the gate first and pass `confirmSecret`.
 */

import { APIRequestContext, expect, Locator, Page } from '@playwright/test';

export const CONFIRM_SECRET = 'e2e-confirm-secret';

/** Arms the confirmation gate for a human session. */
export async function setConfirmSecret(
  request: APIRequestContext,
  sessionToken: string
): Promise<void> {
  const response = await request.post('/api/me/confirm-secret', {
    headers: { Authorization: `Bearer ${sessionToken}` },
    data: { secret: CONFIRM_SECRET },
  });
  expect(response.status()).toBe(200);
}

/** Types the one-time code the form is showing. */
export async function typeConfirmCode(page: Page, scope?: Locator): Promise<void> {
  const root = scope ?? page.locator('body');
  const shown = root.locator('[data-testid="confirm-code-value"]');

  if (await shown.isVisible()) {
    await root.locator('[data-testid="confirm-code"]').fill(((await shown.innerText()) ?? '').trim());
    return;
  }

  // The vault page keeps its gate behind a "Confirmation" popup; every other
  // page renders the gate inline, where the code is already visible.
  const trigger = page.getByRole('button', { name: /^Confirmation/ }).first();
  await trigger.waitFor({ state: 'visible' });
  await trigger.click();
  await shown.waitFor({ state: 'visible' });
  await root.locator('[data-testid="confirm-code"]').fill(((await shown.innerText()) ?? '').trim());
  // Close the dialog so the action the test drives next is clickable; scope it
  // to the dialog because cabinet disclosures may also read "Close".
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
}
