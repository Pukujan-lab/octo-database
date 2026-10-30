/**
 * Shared vision-audit helper for Playwright specs.
 *
 * Fork pull requests never receive repository secrets, so the InferHub key is
 * absent there by design. Rather than failing those PRs on an unsatisfiable
 * dependency, the audit is skipped and the skip is reported loudly. Same-repo
 * runs (including every push to main) perform the real audit.
 *
 * A provider outage (every model in the fallback chain refusing or erroring) is
 * treated the same way: the model never judged the screen, so there is nothing to
 * fail on. A model that answers and scores the screen low still fails the test.
 */

import type { Page } from '@playwright/test';
import { verifyUiScreenshotWithVision, VisionVerificationResult } from '../../src/qa/vision-verifier';

export function visionAuditAvailable(): boolean {
  return Boolean(process.env['INFERHUB_API_KEY'] ?? process.env['inferhub_key']);
}

/**
 * Audits the current page with the vision model, or returns null when the
 * credential is unavailable (fork PR) so the caller can skip assertions.
 */
export async function auditPage(
  page: Page,
  screenName: string
): Promise<VisionVerificationResult | null> {
  if (!visionAuditAvailable()) {
    console.log(
      `[vision-audit] SKIPPED for "${screenName}": INFERHUB_API_KEY is not available in this context ` +
        '(fork pull requests do not receive repository secrets).'
    );
    return null;
  }

  // Views animate in (fade-rise), so a screenshot taken immediately renders the
  // panel half-transparent and the audit judges a transient frame. Fast-forward
  // finite animations to their end state so the model sees the settled screen.
  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
  let result: VisionVerificationResult;
  try {
    result = await verifyUiScreenshotWithVision(screenshot, screenName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('All vision models in fallback chain failed')) throw error;
    console.log(`[vision-audit] SKIPPED for "${screenName}": the vision provider is unavailable. ${message}`);
    return null;
  }

  console.log(`[vision-audit] ${screenName} — model=${result.modelUsed} score=${result.score} passed=${result.passed}`);
  console.log(`[vision-audit] ${result.summary}`);
  for (const issue of result.issues) {
    console.log(`[vision-audit] note: ${issue}`);
  }

  return result;
}
