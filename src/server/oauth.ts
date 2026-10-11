/**
 * OAuth 2.1 authorization server for the remote MCP endpoint.
 *
 * ChatGPT custom connectors cannot hold a bearer key: they offer only OAuth or
 * "no authentication". This module is the server side of that dance, sized to
 * what the MCP authorization spec requires of a resource server's companion
 * authorization server:
 *
 *   /.well-known/oauth-protected-resource      RFC 9728 metadata (401 points here)
 *   /.well-known/oauth-authorization-server    RFC 8414 AS metadata (discovery)
 *   POST /oauth/register                       RFC 7591 dynamic client registration
 *   GET  /oauth/authorize                      authorization-code + PKCE (S256) start
 *   POST /oauth/authorize                      consent submit (session-authenticated)
 *   POST /oauth/token                          code exchange + refresh_token grant
 *
 * Design notes:
 * - Every client is public. PKCE S256 is mandatory; `token_endpoint_auth_method`
 *   is `none` (or `client_secret_post` for the rare client that insists on a
 *   secret, which is then only a form identifier — there is no confidential
 *   client here).
 * - Client IDs are either UUIDs minted at registration (DCR) or https URLs
 *   validated as Client ID Metadata Documents (CIMD): for a URL client_id the
 *   redirect URIs are fetched from the document at the client_id origin, never
 *   taken from the query string.
 * - The user step reuses Octo's own session: a valid `octo_sess_` bearer or the
 *   short-lived dance cookie authenticates the consent POST. Without a session
 *   the browser is sent to Octo's normal login and returned here.
 * - Scopes are Octo's own ('read', 'write', ...). MCP connectors are untrusted
 *   agents, so the consent page offers read-only by default and this server
 *   never mints write scopes for an OAuth client the owner has not asked for.
 * - The `resource` parameter (RFC 8707) is required and stored; the minted
 *   access token carries it as `aud`, and /mcp refuses tokens whose audience
 *   is not its own resource identifier.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { queryService, dbGetAuthorizedWorkspaces } from './db';
import { signOAuthAccessToken, oauthIssuer, oauthResource } from '../lib/oauth-token';
import { verifySessionToken } from '../lib/session-token';
import { getPublicOrigin } from '../lib/public-origin';

const CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TTL_DAYS = 30;
const DANCE_COOKIE_TTL_MS = 10 * 60 * 1000;
const DANCE_COOKIE = 'octo_oauth_dance';

/**
 * The scopes an OAuth client may hold. The client asks for a set on the
 * authorization request; the consent page lets the human widen or narrow it
 * before a token is minted, and the granted set is what the access token carries.
 * The consent page pre-selects exactly what the client asked for, so a read-only
 * client still yields a read-only token unless the human deliberately opts into
 * write or delete.
 */
const OAUTH_ALLOWED_SCOPES = ['read', 'write', 'delete', 'files'];
const DEFAULT_OAUTH_SCOPE = 'read files';

/** Human labels for the consent checkboxes, keyed by scope. */
const SCOPE_LABELS: Record<string, string> = {
  read: 'Read workspace data, activity, and metadata',
  files: 'List and download files',
  write: 'Create and change workspace data and files',
  delete: 'Delete workspace data and files',
};

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function baseHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0d0f12;color:#e8e6e1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{background:#16191f;border:1px solid #2a2f38;border-radius:12px;padding:2rem;max-width:26rem;width:100%}h1{font-size:1.1rem;margin:0 0 1rem}label{display:block;font-size:.85rem;margin:.9rem 0 .3rem}select,input{width:100%;box-sizing:border-box;background:#0d0f12;color:#e8e6e1;border:1px solid #2a2f38;border-radius:8px;padding:.5rem}button{margin-top:1.2rem;width:100%;background:#4f7cff;color:#fff;border:0;border-radius:8px;padding:.6rem;font-size:.95rem;cursor:pointer}.muted{color:#9aa1ab;font-size:.8rem}.scopes{border:0;padding:0;margin:.9rem 0}.scopes legend{font-size:.85rem;padding:0}.scopes label{display:flex;gap:.5rem;align-items:flex-start;margin:.5rem 0;font-size:.85rem;font-weight:400}.scopes input{width:auto;margin-top:.15rem}</style></head><body><main>${body}</main></body></html>`
  );
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req);
  return new URLSearchParams(raw);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers['cookie'];
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds: number): void {
  const existing = res.getHeader('Set-Cookie');
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  const list = existing ? (Array.isArray(existing) ? existing : [String(existing)]) : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

/** Bearer token from the Authorization header, if any. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

interface DanceSession {
  principalId: string;
  exp: number;
}

const danceSessions = new Map<string, DanceSession>();

function mintDanceSession(principalId: string): string {
  const id = randomBytes(24).toString('base64url');
  danceSessions.set(id, { principalId, exp: Date.now() + DANCE_COOKIE_TTL_MS });
  // Names are opaque random ids; the map is bounded by the TTL above. Sweep on
  // mint so abandoned logins cannot accumulate.
  for (const [key, session] of Array.from(danceSessions.entries())) {
    if (session.exp <= Date.now()) danceSessions.delete(key);
  }
  return id;
}

function danceSessionPrincipal(req: IncomingMessage): string | null {
  const cookie = parseCookies(req)[DANCE_COOKIE];
  if (cookie) {
    const session = danceSessions.get(cookie);
    if (session && session.exp > Date.now()) return session.principalId;
  }
  // Fall back to a real Octo session token: the user may already be signed in
  // to the dashboard in this browser, or the client pre-authenticated the call.
  const bearer = bearerToken(req);
  if (bearer?.startsWith('octo_sess_')) return verifySessionToken(bearer);
  return null;
}

interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  client_secret_hash: string | null;
}

async function loadClient(clientId: string | null): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const rows = await queryService<OAuthClient>(
    'SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash FROM octo.oauth_clients WHERE client_id = $1',
    [clientId]
  );
  return rows[0] ?? null;
}

/**
 * Client ID Metadata Documents: when client_id is an https URL, its redirect
 * URIs come from the document hosted AT that URL (same origin), never from the
 * authorization request. The row is cached on first sight so the consent page
 * has a name; the fetch is re-done at authorize time, so a rotated document
 * takes effect without re-registration.
 */
async function resolveCimdClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId.startsWith('https://')) return null;
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return null;
  }
  if (parsed.pathname === '/' || parsed.pathname === '') return null;
  let doc: { client_name?: string; redirect_uris?: string[] };
  try {
    const res = await fetch(clientId, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    doc = (await res.json()) as typeof doc;
  } catch {
    return null;
  }
  const redirectUris = (doc.redirect_uris ?? []).filter(
    (uri) => typeof uri === 'string' && URL.canParse(uri) && new URL(uri).origin === parsed.origin
  );
  if (redirectUris.length === 0) return null;
  const client: OAuthClient = {
    client_id: clientId,
    client_name: typeof doc.client_name === 'string' ? doc.client_name : parsed.hostname,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    client_secret_hash: null,
  };
  await queryService(
    `INSERT INTO octo.oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, $2, $3, 'none')
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, client.client_name, redirectUris]
  );
  return client;
}

async function resolveClient(clientId: string | null): Promise<OAuthClient | null> {
  const existing = await loadClient(clientId);
  if (existing) return existing;
  if (clientId && clientId.startsWith('https://')) return resolveCimdClient(clientId);
  return null;
}

// --- Metadata -----------------------------------------------------------------

function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: oauthResource(),
    authorization_servers: [origin],
    scopes_supported: OAUTH_ALLOWED_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: OAUTH_ALLOWED_SCOPES,
    // RFC 9207: the authorization response carries iss so the client can tell
    // which server minted the code before spending it.
    authorization_response_iss_parameter_supported: true,
  };
}

// --- Authorization endpoint -----------------------------------------------------

interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  scope: string | null;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  resource: string | null;
}

function authorizeParams(url: URL): AuthorizeParams {
  return {
    responseType: url.searchParams.get('response_type'),
    clientId: url.searchParams.get('client_id'),
    redirectUri: url.searchParams.get('redirect_uri'),
    scope: url.searchParams.get('scope'),
    state: url.searchParams.get('state'),
    codeChallenge: url.searchParams.get('code_challenge'),
    codeChallengeMethod: url.searchParams.get('code_challenge_method'),
    resource: url.searchParams.get('resource'),
  };
}

/** Error redirect per RFC 6749 §4.1.2.1 — only once redirect_uri is validated. */
function redirectError(res: ServerResponse, redirectUri: string, code: string, state: string | null): void {
  const target = new URL(redirectUri);
  target.searchParams.set('error', code);
  if (state) target.searchParams.set('state', state);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43,128}$/;

async function validateAuthorizeRequest(
  params: AuthorizeParams
): Promise<{ client: OAuthClient; redirectUri: string; scope: string; resource: string } | { errorPage: [number, string, string] } | { errorRedirect: [string, string] }> {
  if (params.responseType !== 'code') {
    return { errorRedirect: ['unsupported_response_type', params.state ?? ''] };
  }
  if (!params.clientId) {
    return { errorPage: [400, 'Invalid request', 'client_id is required.'] };
  }
  const client = await resolveClient(params.clientId);
  if (!client) {
    return { errorPage: [400, 'Unknown client', 'This client is not registered with Octo.'] };
  }
  const redirectUri = params.redirectUri ?? client.redirect_uris[0] ?? null;
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { errorPage: [400, 'Invalid redirect', 'The redirect URI does not match the client registration.'] };
  }
  if (!params.codeChallenge || !PKCE_CHALLENGE_PATTERN.test(params.codeChallenge)) {
    return { errorRedirect: ['invalid_request', params.state ?? ''] };
  }
  if (params.codeChallengeMethod !== 'S256') {
    // Plain is forbidden by OAuth 2.1; nothing else is supported.
    return { errorRedirect: ['invalid_request', params.state ?? ''] };
  }
  if (!params.resource) {
    return { errorRedirect: ['invalid_target', params.state ?? ''] };
  }
  const requested = params.scope && params.scope.trim() ? params.scope : DEFAULT_OAUTH_SCOPE;
  const scopes = requested.split(/[\s+]/).filter(Boolean);
  if (scopes.length === 0 || scopes.some((s) => !OAUTH_ALLOWED_SCOPES.includes(s))) {
    return { errorRedirect: ['invalid_scope', params.state ?? ''] };
  }
  return { client, redirectUri, scope: scopes.join(' '), resource: params.resource };
}

function consentPage(
  client: OAuthClient,
  params: AuthorizeParams,
  scope: string,
  workspaces: { id: string; name: string }[]
): string {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${name}" value="${esc(value)}" />`;
  const options = workspaces
    .map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`)
    .join('');
  const requested = new Set(scope.split(' ').filter(Boolean));
  const scopeBoxes = OAUTH_ALLOWED_SCOPES.map((s) => {
    const checked = requested.has(s) ? ' checked' : '';
    return (
      `<label><input type="checkbox" name="scope" value="${esc(s)}"${checked} />` +
      `<span><strong>${esc(s)}</strong> — ${esc(SCOPE_LABELS[s] ?? '')}</span></label>`
    );
  }).join('');
  return (
    `<h1>Connect to Octo</h1>` +
    `<p class="muted"><strong>${esc(client.client_name ?? params.clientId!)}</strong> wants to connect to one Octo workspace through the MCP API. Choose what it may do.</p>` +
    `<form method="post" action="/oauth/authorize">` +
    hidden('client_id', params.clientId!) +
    hidden('redirect_uri', params.redirectUri ?? '') +
    hidden('state', params.state ?? '') +
    hidden('code_challenge', params.codeChallenge!) +
    hidden('code_challenge_method', 'S256') +
    hidden('resource', params.resource!) +
    `<label>Workspace<select name="workspace_id" required>${options}</select></label>` +
    `<fieldset class="scopes"><legend>Permissions</legend>${scopeBoxes}</fieldset>` +
    `<button type="submit">Allow access</button>` +
    `</form><p class="muted">The granted permissions are recorded on the connection. Revoke them any time by removing its access.</p>`
  );
}

async function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const origin = getPublicOrigin(req, url);
  const params = authorizeParams(url);
  const validated = await validateAuthorizeRequest(params);
  if ('errorPage' in validated) {
    const [status, title, message] = validated.errorPage;
    baseHtml(res, status, title, `<h1>${esc(title)}</h1><p class="muted">${esc(message)}</p>`);
    return;
  }
  if ('errorRedirect' in validated) {
    if (params.redirectUri && params.clientId) {
      const client = await resolveClient(params.clientId);
      if (client && client.redirect_uris.includes(params.redirectUri)) {
        redirectError(res, params.redirectUri, validated.errorRedirect[0], params.state);
        return;
      }
    }
    baseHtml(res, 400, 'Invalid request', '<h1>Invalid request</h1><p class="muted">The authorization request is missing required parameters.</p>');
    return;
  }

  const principalId = danceSessionPrincipal(req);
  if (!principalId) {
    // Not signed in: bounce through Octo's own login and come straight back.
    const returnTo = `${origin}/oauth/authorize?${url.searchParams.toString()}`;
    res.writeHead(302, { Location: `${origin}/#oauth_return=${encodeURIComponent(returnTo)}` });
    res.end();
    return;
  }

  // The consent page lists only workspaces this principal may act in, resolved
  // server-side (the dance cookie is an opaque id, not a bearer credential, so
  // there is nothing for the browser to fetch with).
  const workspaces = await dbGetAuthorizedWorkspaces(principalId);
  if (workspaces.length === 0) {
    baseHtml(res, 403, 'No workspace', '<h1>No workspace available</h1><p class="muted">This account has no workspace to connect. Create one in Octo first.</p>');
    return;
  }

  baseHtml(res, 200, 'Connect to Octo', consentPage(validated.client, params, validated.scope, workspaces));
}

async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const origin = getPublicOrigin(req, url);
  const form = await readForm(req);
  const grantedScopes = form.getAll('scope').map((s) => s.trim()).filter(Boolean);
  if (grantedScopes.length === 0) {
    baseHtml(res, 400, 'No permissions', '<h1>No permissions selected</h1><p class="muted">Choose at least one permission to grant this connection.</p>');
    return;
  }
  const params: AuthorizeParams = {
    responseType: 'code',
    clientId: form.get('client_id'),
    redirectUri: form.get('redirect_uri'),
    scope: grantedScopes.join(' '),
    state: form.get('state'),
    codeChallenge: form.get('code_challenge'),
    codeChallengeMethod: form.get('code_challenge_method'),
    resource: form.get('resource'),
  };
  const validated = await validateAuthorizeRequest(params);
  if ('errorPage' in validated || 'errorRedirect' in validated) {
    baseHtml(res, 400, 'Invalid request', '<h1>Invalid request</h1><p class="muted">The authorization request could not be validated.</p>');
    return;
  }
  const principalId = danceSessionPrincipal(req);
  if (!principalId) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><p>Session expired. Restart the connection from your MCP client.</p></body></html>');
    return;
  }
  const workspaceId = form.get('workspace_id');
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId)) {
    baseHtml(res, 400, 'Invalid request', '<h1>Invalid request</h1><p class="muted">Choose a workspace.</p>');
    return;
  }
  // Consent is only valid for a workspace the principal can actually reach —
  // the same authorization the dashboard's workspace list applies, so a forged
  // workspace_id in the form cannot mint a code for someone else's workspace.
  const authorized = await dbGetAuthorizedWorkspaces(principalId);
  if (!authorized.some((w) => w.id === workspaceId)) {
    baseHtml(res, 403, 'Not allowed', '<h1>Not allowed</h1><p class="muted">That workspace does not belong to this account.</p>');
    return;
  }

  const code = randomBytes(32).toString('base64url');
  await queryService(
    `INSERT INTO octo.oauth_auth_codes
       (code_hash, client_id, principal_id, workspace_id, redirect_uri,
        code_challenge, code_challenge_method, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'S256', $7, $8, now() + interval '5 minutes')`,
    [sha256(code), validated.client.client_id, principalId, workspaceId, validated.redirectUri, params.codeChallenge, validated.scope, validated.resource]
  );

  const target = new URL(validated.redirectUri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  target.searchParams.set('iss', origin);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

// --- Token endpoint -------------------------------------------------------------

async function issueTokens(params: {
  clientId: string;
  principalId: string;
  workspaceId: string;
  scope: string;
  resource: string;
  familyId?: string;
}): Promise<Record<string, unknown>> {
  const accessToken = signOAuthAccessToken({
    principalId: params.principalId,
    workspaceId: params.workspaceId,
    scopes: params.scope.split(' '),
    resource: params.resource,
  });
  const refreshToken = params.familyId ? randomBytes(32).toString('base64url') : null;
  if (refreshToken) {
    await queryService(
      `INSERT INTO octo.oauth_refresh_tokens
         (token_hash, family_id, client_id, principal_id, workspace_id, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' days')::interval)`,
      [sha256(refreshToken), params.familyId, params.clientId, params.principalId, params.workspaceId, params.scope, params.resource, String(REFRESH_TTL_DAYS)]
    );
  }
  return {
    access_token: accessToken.token,
    token_type: 'Bearer',
    expires_in: accessToken.expiresIn,
    scope: params.scope,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

async function handleToken(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const origin = getPublicOrigin(req, url);
  const tokenError = (status: number, code: string, description?: string): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: code, ...(description ? { error_description: description } : {}) }));
  };

  const form = await readForm(req);
  const grantType = form.get('grant_type');
  const clientId = form.get('client_id');

  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    if (!code || !verifier || !clientId) {
      tokenError(400, 'invalid_request');
      return;
    }
    const client = await resolveClient(clientId);
    if (!client) {
      tokenError(401, 'invalid_client');
      return;
    }
    if (client.token_endpoint_auth_method === 'client_secret_post') {
      const secret = form.get('client_secret');
      if (!secret || !client.client_secret_hash || sha256(secret) !== client.client_secret_hash) {
        tokenError(401, 'invalid_client');
        return;
      }
    }
    // Single-use claim: the conditional UPDATE consumes the row or finds it
    // already gone/consumed. A replayed code therefore redeems nothing.
    const claimed = await queryService<{
      client_id: string;
      principal_id: string;
      workspace_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string;
      resource: string;
    }>(
      `UPDATE octo.oauth_auth_codes
       SET consumed_at = now()
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING client_id, principal_id, workspace_id, redirect_uri, code_challenge, scope, resource`,
      [sha256(code)]
    );
    if (claimed.length === 0) {
      tokenError(400, 'invalid_grant', 'authorization code is invalid, expired, or already used');
      return;
    }
    const row = claimed[0]!;
    if (row.client_id !== clientId) {
      tokenError(400, 'invalid_grant', 'code was issued to a different client');
      return;
    }
    const redirectUri = form.get('redirect_uri');
    if (redirectUri && redirectUri !== row.redirect_uri) {
      tokenError(400, 'invalid_grant', 'redirect_uri mismatch');
      return;
    }
    const expected = createHash('sha256').update(verifier).digest('base64url');
    if (!constantTimeEquals(expected, row.code_challenge)) {
      tokenError(400, 'invalid_grant', 'PKCE verification failed');
      return;
    }
    const body = await issueTokens({
      clientId,
      principalId: row.principal_id,
      workspaceId: row.workspace_id,
      scope: row.scope,
      resource: row.resource,
      familyId: randomUUID(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken || !clientId) {
      tokenError(400, 'invalid_request');
      return;
    }
    const client = await resolveClient(clientId);
    if (!client) {
      tokenError(401, 'invalid_client');
      return;
    }
    const rows = await queryService<{
      family_id: string;
      client_id: string;
      principal_id: string;
      workspace_id: string;
      scope: string;
      resource: string;
      not_expired: boolean;
      revoked_at: string | null;
    }>(
      // Expiry is decided by the database, not by comparing a timestamp to a
      // JS date string: the driver hands timestamptz back as a Date, and
      // `Date <= string` coerces to NaN — every token would look live.
      `SELECT family_id, client_id, principal_id, workspace_id, scope, resource,
              (expires_at > now()) AS not_expired, revoked_at
         FROM octo.oauth_refresh_tokens WHERE token_hash = $1`,
      [sha256(refreshToken)]
    );
    const row = rows[0];
    if (!row || !row.not_expired || row.revoked_at) {
      // Unknown, expired, or already-rotated token. If it was rotated (a live
      // family exists with this token revoked), replay of a stolen token kills
      // the whole family so the thief cannot keep the session alive.
      if (row?.revoked_at) {
        await queryService(
          'UPDATE octo.oauth_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id]
        );
      }
      tokenError(400, 'invalid_grant', 'refresh token is invalid, expired, or revoked');
      return;
    }
    if (row.client_id !== clientId) {
      tokenError(400, 'invalid_grant', 'refresh token was issued to a different client');
      return;
    }
    // Rotation: revoke the presented token and issue its successor in the same
    // family. If the revoke races a concurrent refresh of the same token, only
    // one wins the UPDATE ... WHERE revoked_at IS NULL gate; the loser finds
    // zero rows and must not mint.
    const rotated = await queryService<{ token_hash: string }>(
      'UPDATE octo.oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING token_hash',
      [sha256(refreshToken)]
    );
    if (rotated.length === 0) {
      tokenError(400, 'invalid_grant', 'refresh token is invalid, expired, or revoked');
      return;
    }
    const body = await issueTokens({
      clientId,
      principalId: row.principal_id,
      workspaceId: row.workspace_id,
      scope: row.scope,
      resource: row.resource,
      familyId: row.family_id,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }

  tokenError(400, 'unsupported_grant_type');
}

// --- Registration ----------------------------------------------------------------

async function handleRegister(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  void url;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && URL.canParse(u))
    : [];
  if (redirectUris.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_redirect_uri' }));
    return;
  }
  const requestedAuth = body.token_endpoint_auth_method;
  const authMethod = requestedAuth === 'client_secret_post' ? 'client_secret_post' : 'none';
  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null;
  const clientId = randomUUID();
  // Public clients get no secret at all; a client that insists on
  // client_secret_post gets one, stored hashed, though it buys nothing here
  // because every client is public under OAuth 2.1 + PKCE.
  const clientSecret = authMethod === 'client_secret_post' ? randomBytes(32).toString('base64url') : null;
  await queryService(
    'INSERT INTO octo.oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash) VALUES ($1, $2, $3, $4, $5)',
    [clientId, clientName, redirectUris, authMethod, clientSecret ? sha256(clientSecret) : null]
  );
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    })
  );
}

// --- Dispatch ---------------------------------------------------------------------

/** 401 with the RFC 6750 WWW-Authenticate challenge pointing at the metadata. */
export function sendWwwAuthenticate(res: ServerResponse, origin: string): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
  res.end(JSON.stringify({ error: 'UNAUTHORIZED: a valid Octo bearer token is required' }));
}

/**
 * Runs the OAuth surface. Returns false when the request is not an OAuth route,
 * so the main dispatcher keeps looking. Must be called before any body-reading
 * route in the main dispatcher.
 */
export async function handleOAuthRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  const origin = getPublicOrigin(req, url);

  if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(protectedResourceMetadata(origin)));
    return true;
  }
  if (pathname === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(authorizationServerMetadata(origin)));
    return true;
  }
  if (pathname === '/oauth/dance' && req.method === 'POST') {
    // The bridge between Octo's own login (a bearer token in localStorage) and
    // this browser flow (a cookie the server can read). The dashboard posts its
    // session token here; it becomes a short-lived HttpOnly cookie, so the
    // session token itself never rides in a URL and the consent page has an
    // identity to attribute the grant to.
    const token = bearerToken(req);
    const principalId = token?.startsWith('octo_sess_') ? verifySessionToken(token) : null;
    if (!principalId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'UNAUTHENTICATED' }));
      return true;
    }
    setCookie(res, DANCE_COOKIE, mintDanceSession(principalId), Math.floor(DANCE_COOKIE_TTL_MS / 1000));
    res.writeHead(204);
    res.end();
    return true;
  }
  if (pathname === '/oauth/register' && req.method === 'POST') {
    await handleRegister(req, res, url);
    return true;
  }
  if (pathname === '/oauth/authorize' && req.method === 'GET') {
    await handleAuthorizeGet(req, res, url);
    return true;
  }
  if (pathname === '/oauth/authorize' && req.method === 'POST') {
    await handleAuthorizePost(req, res, url);
    return true;
  }
  if (pathname === '/oauth/token' && req.method === 'POST') {
    await handleToken(req, res, url);
    return true;
  }
  return false;
}

export { mintDanceSession, DANCE_COOKIE, danceSessionPrincipal };
