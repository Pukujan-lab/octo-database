/**
 * Google sign-in configuration and the Cloudflare Turnstile guest challenge.
 */



export function getGoogleClientCredentials(): { clientId: string | null; clientSecret: string | null } {
  const clientId = process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? process.env['GOOGLE_CLIENT_ID'] ?? null;
  const clientSecret = process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? process.env['GOOGLE_CLIENT_SECRET'] ?? null;
  return { clientId, clientSecret };
}

/** Public Turnstile site key for the login widget, or null when unconfigured. */
export function getTurnstileSiteKey(): string | null {
  return process.env['TURNSTILE_SITE_KEY']?.trim() || null;
}

/**
 * Verifies a Cloudflare Turnstile token for the guest-login challenge.
 *
 * Returns true when the challenge passed. When no secret is configured the
 * check is skipped (true): CI and local dev run without Cloudflare, and a
 * deployment that has not set the secret yet must not lock guests out — the
 * same fail-open shape as googleAuthEnabled. Set TURNSTILE_SECRET_KEY to arm it.
 */
export async function verifyTurnstile(token: unknown, remoteIp: string | null): Promise<boolean> {
  const secret = process.env['TURNSTILE_SECRET_KEY']?.trim();
  if (!secret) return true;
  if (typeof token !== 'string' || !token.trim()) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    // A network failure must not admit an unverified caller.
    return false;
  }
}
