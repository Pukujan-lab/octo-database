/**
 * Playwright E2E & Vision Model UI/UX Verification
 *
 * Verifies live browser interaction, layout integrity, and runs multimodal vision
 * verification (Qwen 3.8 Flash fallback chain via InferHub) on rendered screenshots.
 */

import { expect, test, Page } from '@playwright/test';
import { auditPage } from './vision-audit';
import { typeConfirmCode } from './confirm-secret';

/**
 * Arms the confirmation gate inside the mint dialog. Minting is stamped, so the
 * human must type the one-time code the form is showing; the code lives in the
 * ConfirmGate rendered within the dialog.
 */
async function armConfirmSecret(page: Page): Promise<void> {
  await typeConfirmCode(page);
}

test.describe('Octo Full-Stack Dashboard E2E & Vision QA', () => {
  test('renders login screen, audits visual quality with vision model, and enters guest mode', async ({
    page,
  }) => {
    test.setTimeout(180000);
    // 1. Navigate to application
    await page.goto('/');
    await expect(page.getByTestId('login-screen')).toBeVisible();

    // Google sign-in is only offered when an OAuth client is provisioned; otherwise
    // the control must report that state instead of linking to a dead route.
    const googleConfigured = Boolean(process.env['GOOGLE_OAUTH_CLIENT_ID']);
    const google = page.getByTestId('login-google');
    if (googleConfigured) {
      await expect(google).toBeEnabled();
    } else {
      await expect(google).toBeDisabled();
    }
    await expect(page.getByRole('button', { name: 'Continue as Guest' })).toBeVisible();

    // 2 & 3. Multimodal Vision Audit (Qwen 3.8 Flash on InferHub).
    // Skipped only where the credential cannot exist (fork PRs); every same-repo
    // run performs the real audit.
    const loginVisionResult = await auditPage(page, 'Login Screen');
    if (loginVisionResult) {
      expect(loginVisionResult.passed).toBe(true);
      expect(loginVisionResult.score).toBeGreaterThanOrEqual(75);
    }

    // 4. Start a guest session
    await page.getByTestId('login-guest').click();

    // 5. Verify the authenticated shell renders with the guest workspace.
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Personal (Guest)', exact: true }).first()).toBeVisible();
    // The guest badge renders in both the shell banner and the overview header.
    await expect(page.getByText('guest session').first()).toBeVisible();
    await expect(page.getByText('File Catalog')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Gallery$/ })).toBeVisible();

    // 6 & 7. Multimodal Vision Audit on the authenticated dashboard.
    const dashVisionResult = await auditPage(page, 'Dashboard');
    if (dashVisionResult) {
      expect(dashVisionResult.passed).toBe(true);
      expect(dashVisionResult.score).toBeGreaterThanOrEqual(75);
    }

    // 8. Test File Upload via the focused Files view.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    // The toolbar and the empty state both offer "New text file"; the toolbar is first.
    await page.getByRole('button', { name: 'New text file' }).first().click();
    await page.locator('#text-file-name').fill('qa_report.txt');
    await page.locator('#text-file-body').fill('Live visual QA report verification text.');
    await page.getByRole('button', { name: 'Create file' }).click();

    // Verify file appears in the table. The name is its own cell; the row also
    // carries the storage key and the per-file actions, so match the name exactly.
    await expect(page.getByText('qa_report.txt', { exact: true })).toBeVisible();

    // 9. Test API Key Generation via Access.
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
    await page.getByRole('button', { name: 'Mint a key' }).first().click();
    await expect(page.locator('[data-testid="key-mint-form"]')).toBeVisible();
    await page.locator('#key-name').fill('Vision E2E Agent');
    await armConfirmSecret(page);
    await page.getByRole('button', { name: 'Mint key' }).click();

    // Verify the minted key appears as a one-time secret. The exact pattern avoids
    // matching the `octo_live_ws_...` placeholder in any curl example.
    await expect(page.locator('[data-testid="one-time-secret"]')).toBeVisible();
    await expect(page.getByText(/^octo_live_ws_[0-9a-f]{32}$/)).toBeVisible();

    // 10. Sign out cleanly
    await page.locator('[data-testid="app-nav"] button[aria-label="Sign out"]').click();
    await expect(page.getByTestId('login-screen')).toBeVisible();
  });

  test('applies the saved color theme on the login screen, not only inside the app', async ({
    page,
  }) => {
    // The design-system attribute drives which palette the whole document uses. It
    // was set only when the authenticated shell rendered, so a returning user who
    // chose the paper theme still saw the dark login screen on a fresh load.
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('octo_design_system', 'paper'));
    await page.reload();

    await expect(page.getByTestId('login-screen')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-design', 'paper');
  });

  test('surfaces a workspace load failure instead of a misleading empty workspace', async ({
    page,
  }) => {
    // A single failing workspace request (here the file listing) must not be
    // silently coerced to an empty list: an empty workspace and a failed one look
    // identical to the user, and only the latter needs attention.
    await page.goto('/');
    await page.route(/\/api\/files\?/, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'INTERNAL_SERVER_ERROR' }),
      })
    );
    await page.getByTestId('login-guest').click();
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    // The overview banner carries the same phrase as a warning; the error state is
    // the heading the reader acts on.
    await expect(page.getByRole('heading', { name: 'Could not load files' })).toBeVisible();
  });

  test('a disabled Google button keeps its label legible instead of fading it out', async ({
    page,
  }) => {
    // The disabled "not configured" Google control is the only signal that Google
    // auth is off, so its label must stay readable. A blanket opacity dims the text
    // toward the panel until it can no longer be read; measure the rendered
    // contrast and require comfortably legible text.
    await page.goto('/');
    const google = page.getByTestId('login-google');
    test.skip(!(await google.isDisabled()), 'Google sign-in is configured in this environment');
    await expect(google).toBeDisabled();

    const ratio = await google.evaluate((el) => {
      const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number);
      const linear = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      const luminance = (rgb: number[]) =>
        0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
      const style = getComputedStyle(el);
      const opacity = Number(style.opacity);
      const page = channels(getComputedStyle(document.body).backgroundColor);
      // Opacity composites the whole control (label over its own surface) toward
      // whatever sits behind it, so model that before comparing the two.
      const seen = (color: string) =>
        channels(color).map((value, i) => value * opacity + page[i] * (1 - opacity));
      const [bright, dim] = [luminance(seen(style.color)), luminance(seen(style.backgroundColor))].sort(
        (a, b) => b - a
      );
      return (bright + 0.05) / (dim + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  test('discards a dead persisted session instead of showing an empty workspace shell', async ({
    page,
  }) => {
    // Reproduces the reported state: a token in localStorage that the server no
    // longer honours, alongside a persisted principal. Before revalidation the
    // app kept the stale principal and rendered the authenticated shell; the
    // server is the authority, so an expired token must return the caller to the
    // login screen.
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('octo_token', '00000000-0000-0000-0000-000000000000');
      localStorage.setItem(
        'octo_principal',
        JSON.stringify({
          principal: {
            id: '00000000-0000-0000-0000-000000000000',
            email: 'stale@example.com',
            displayName: 'Stale User',
            avatarUrl: null,
            isPlatformOwner: false,
            isGuest: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          sessionExpiresAt: Date.now() + 20 * 60 * 1000,
          lastActivityAt: Date.now(),
        })
      );
    });
    await page.reload();

    await expect(page.getByTestId('login-screen')).toBeVisible();
    await expect(page.locator('[data-testid="app-nav"]')).toHaveCount(0);

    // The dead credential is cleared, not left behind to fail every later call.
    const token = await page.evaluate(() => localStorage.getItem('octo_token'));
    expect(token).toBeNull();
  });

  test('a one-time secret does not survive sign-out into the next session', async ({ page }) => {
    // The minted secret lives in client state, not localStorage. If sign-out
    // clears only the token and principal, the secret stays in memory and the
    // Access view renders it for the next person who signs in on this machine —
    // a one-time key disclosed to a different session. Sign-out must clear it.
    await page.goto('/');
    await page.getByTestId('login-guest').click();
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await page.getByRole('button', { name: 'Mint a key' }).first().click();
    await page.locator('#key-name').fill('Leak Probe Agent');
    await armConfirmSecret(page);
    await page.getByRole('button', { name: 'Mint key' }).click();

    const secret = page.locator('[data-testid="one-time-secret"] p.num');
    await expect(secret).toBeVisible();
    const value = ((await secret.innerText()) ?? '').trim();
    expect(value).toMatch(/^octo_live_ws_[0-9a-f]{32}$/);

    await page.locator('[data-testid="app-nav"] button[aria-label="Sign out"]').click();
    await expect(page.getByTestId('login-screen')).toBeVisible();

    // A fresh guest session must not be shown the previous session's key.
    await page.getByTestId('login-guest').click();
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await expect(page.getByText(value, { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-testid="one-time-secret"]')).toHaveCount(0);
  });
});
