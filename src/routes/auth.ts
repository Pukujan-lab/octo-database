/**
 * Sign-in: Google OAuth start/callback and the guest session.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { guestSlug, personalSlug } from '../lib/provisioning-slug';
import { getPublicOrigin } from '../lib/public-origin';
import { signSessionToken } from '../lib/session-token';
import { dbGetAuthorizedWorkspaces, dbInsertGuestPrincipal, dbInsertMembership, dbInsertWorkspace, dbUpsertGooglePrincipal } from '../server/db';
import { getGoogleClientCredentials, verifyTurnstile } from '../server/google-auth';
import { readJsonObject, sendJson } from '../server/http';
import { createHash, randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 1b. Google OAuth start. Reports a clear state instead of a dead 404 when the
  // OAuth client has not been provisioned yet.
  if (pathname === '/api/auth/google' && req.method === 'GET') {
    const { clientId } = getGoogleClientCredentials();
    if (!clientId) {
      sendJson(res, 501, {
        error:
          'GOOGLE_AUTH_NOT_CONFIGURED: Set GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET, or use Guest access.',
      });
      return true;
    }
    const origin = getPublicOrigin(req, url);
    const redirectUri = `${origin}/api/auth/google/callback`;
    const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid email profile');
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    res.writeHead(302, { Location: authorizeUrl.toString() });
    res.end();
    return true;
  }

  // 1c. Google OAuth callback: GET /api/auth/google/callback
  if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
    const origin = getPublicOrigin(req, url);
    const errorParam = url.searchParams.get('error');
    if (errorParam) {
      console.warn(
        'Google auth callback returned an error:',
        errorParam,
        url.searchParams.get('error_description') ?? ''
      );
      res.writeHead(302, { Location: `${origin}/#auth_error=${encodeURIComponent(errorParam)}` });
      res.end();
      return true;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      const queryKeys = url.searchParams
        .toString()
        .split('&')
        .map((pair) => pair.split('=')[0])
        .filter(Boolean);
      console.warn('Google auth callback arrived without a code; query keys:', queryKeys);
      res.writeHead(302, { Location: `${origin}/#auth_error=MISSING_CODE` });
      res.end();
      return true;
    }
    const { clientId, clientSecret } = getGoogleClientCredentials();
    if (!clientId || !clientSecret) {
      res.writeHead(302, { Location: `${origin}/#auth_error=GOOGLE_AUTH_NOT_CONFIGURED` });
      res.end();
      return true;
    }
    const redirectUri = `${origin}/api/auth/google/callback`;
    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        console.error('Google token exchange failed:', tokenResponse.status, errText);
        res.writeHead(302, { Location: `${origin}/#auth_error=TOKEN_EXCHANGE_FAILED` });
        res.end();
        return true;
      }

      const tokenData = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
      let sub = '';
      let email = '';
      let displayName: string | null = null;
      let avatarUrl: string | null = null;

      if (tokenData.id_token) {
        try {
          const parts = tokenData.id_token.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
            sub = payload.sub ?? '';
            email = payload.email ?? '';
            displayName = payload.name ?? null;
            avatarUrl = payload.picture ?? null;
          }
        } catch (e) {
          console.warn('Could not parse Google id_token payload:', e);
        }
      }

      if ((!sub || !email) && tokenData.access_token) {
        const userinfoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userinfoRes.ok) {
          const userinfo = (await userinfoRes.json()) as {
            sub?: string;
            email?: string;
            name?: string;
            picture?: string;
          };
          sub = userinfo.sub ?? sub;
          email = userinfo.email ?? email;
          displayName = userinfo.name ?? displayName;
          avatarUrl = userinfo.picture ?? avatarUrl;
        }
      }

      if (!sub || !email) {
        console.warn('Google profile incomplete:', { hasSub: Boolean(sub), hasEmail: Boolean(email) });
        res.writeHead(302, { Location: `${origin}/#auth_error=MISSING_PROFILE` });
        res.end();
        return true;
      }

      // Derive deterministic RFC4122-compatible UUID for sub to satisfy PostgreSQL UUID type
      const subHash = createHash('sha256').update(`google:${sub}`).digest('hex');
      const authUserId = `${subHash.slice(0, 8)}-${subHash.slice(8, 12)}-4${subHash.slice(13, 16)}-a${subHash.slice(17, 20)}-${subHash.slice(20, 32)}`;

      const principal = await dbUpsertGooglePrincipal(authUserId, email, displayName, avatarUrl);

      // Ensure the principal has at least one workspace to enter
      const workspaces = await dbGetAuthorizedWorkspaces(principal.id);
      if (workspaces.length === 0) {
        const slug = personalSlug(principal.id);
        const ws = await dbInsertWorkspace(
          randomUUID(),
          slug,
          'Personal',
          'Personal workspace',
          principal.id
        );
        await dbInsertMembership(ws.id, principal.id, 'owner');
      }

      console.log('Google sign-in completed:', {
        principalId: principal.id,
        isPlatformOwner: principal.isPlatformOwner,
        provisionedWorkspace: workspaces.length === 0,
      });
      res.writeHead(302, { Location: `${origin}/#token=${signSessionToken(principal.id)}` });
      res.end();
      return true;
    } catch (err) {
      console.error('Google auth callback error:', err);
      res.writeHead(302, { Location: `${origin}/#auth_error=INTERNAL_ERROR` });
      res.end();
      return true;
    }
  }

  // 2. Guest Login: POST /api/auth/guest
  if (pathname === '/api/auth/guest' && req.method === 'POST') {
    // Cloudflare Turnstile challenge ("are you a bot"). Fail-open when the
    // secret is unset (CI/dev); armed once TURNSTILE_SECRET_KEY exists.
    const remoteIp =
      (req.headers['cf-connecting-ip'] as string | undefined)?.trim() ||
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      null;
    const parsed = await readJsonObject(req);
    if (!(await verifyTurnstile(parsed.turnstileToken, remoteIp))) {
      sendJson(res, 403, { error: 'TURNSTILE_FAILED: complete the human check and try again.' });
      return true;
    }
    const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : 'Guest User';

    const guestId = randomUUID();
    const slug = guestSlug(guestId);
    const email = `${slug}@octo.local`;

    // Insert guest principal in PostgreSQL
    const principal = await dbInsertGuestPrincipal(guestId, guestId, email, displayName);

    // Auto-provision Personal (Guest) workspace in PostgreSQL
    const workspaceId = randomUUID();
    const workspace = await dbInsertWorkspace(
      workspaceId,
      slug,
      'Personal (Guest)',
      'Auto-provisioned personal sandbox workspace',
      principal.id
    );

    // Insert owner membership in PostgreSQL
    await dbInsertMembership(workspace.id, principal.id, 'owner');

    sendJson(res, 201, {
      principal: {
        id: principal.id,
        email: principal.email,
        displayName: principal.displayName,
        isGuest: true,
        isPlatformOwner: false,
      },
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        role: 'owner',
      },
      sessionToken: signSessionToken(principal.id),
    });
    return true;
  }

  return false;
}
