/**
 * Playwright E2E: OAuth 2.1 authorization for the remote MCP endpoint.
 *
 * Drives the whole dance the way a hosted MCP client (ChatGPT) does: discover
 * the authorization server from the 401 challenge, register a client, run
 * authorization-code + PKCE (S256), exchange the code for an access token, and
 * call /mcp with it. Then it proves the token's authority is bounded — read-only,
 * one workspace — and that the older bearer-key path still works.
 *
 * The failure modes are asserted explicitly: a replayed code, a wrong PKCE
 * verifier, a cross-workspace call, and the retired /mcp/<key> form.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

// The server is launched by playwright.config's webServer with these secrets; the
// test process shares them only so a valid session token can be forged if needed.
process.env['OCTO_SESSION_SECRET'] ??= 'e2e-session-secret';
process.env['OCTO_OAUTH_SECRET'] ??= 'e2e-oauth-secret';

const REDIRECT_URI = 'https://connector.example.com/oauth/callback';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const mcpHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

function rpc(method: string, id: number, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = (randomUUID() + randomUUID()).replace(/-/g, '');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface GuestSession {
  principal: { id: string };
  workspace: { id: string };
  sessionToken: string;
}

async function createGuest(request: APIRequestContext, label: string): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `OAuth E2E ${label} ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as GuestSession;
}

async function registerClient(request: APIRequestContext): Promise<string> {
  const response = await request.post('/oauth/register', {
    data: { client_name: 'Octo E2E Connector', redirect_uris: [REDIRECT_URI] },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

/** Runs the consent POST and returns the authorization code. */
async function authorize(
  request: APIRequestContext,
  guest: GuestSession,
  clientId: string,
  resource: string,
  challenge: string,
  workspaceId: string,
  scope = 'read files'
): Promise<string> {
  const response = await request.post('/oauth/authorize', {
    headers: bearer(guest.sessionToken),
    form: {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope,
      state: 'e2e-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      workspace_id: workspaceId,
    },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  const location = response.headers()['location'];
  expect(location).toBeTruthy();
  const parsed = new URL(location!);
  expect(parsed.origin + parsed.pathname).toBe(REDIRECT_URI);
  expect(parsed.searchParams.get('state')).toBe('e2e-state');
  expect(parsed.searchParams.get('iss')).toBeTruthy();
  const code = parsed.searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

async function exchange(
  request: APIRequestContext,
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: { access_token?: string; refresh_token?: string; error?: string } }> {
  const response = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  return { status: response.status(), body: (await response.json()) as never };
}

test.describe('OAuth 2.1 authorization for /mcp', () => {
  test('discovery, the 401 challenge, and dynamic client registration', async ({ request }) => {
    const prm = await request.get('/.well-known/oauth-protected-resource');
    expect(prm.status()).toBe(200);
    const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(prmBody.resource.endsWith('/mcp')).toBe(true);
    expect(prmBody.authorization_servers.length).toBeGreaterThan(0);

    const asm = await request.get('/.well-known/oauth-authorization-server');
    expect(asm.status()).toBe(200);
    const asmBody = (await asm.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(asmBody.authorization_endpoint).toContain('/oauth/authorize');
    expect(asmBody.token_endpoint).toContain('/oauth/token');
    expect(asmBody.code_challenge_methods_supported).toContain('S256');

    // An unauthenticated /mcp call carries the challenge that points a client at
    // the metadata above.
    const unauth = await request.post('/mcp', {
      headers: mcpHeaders(),
      data: rpc('tools/list', 1),
      maxRedirects: 0,
    });
    expect(unauth.status()).toBe(401);
    expect(unauth.headers()['www-authenticate']).toContain('resource_metadata=');

    const clientId = await registerClient(request);
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('authorization-code + PKCE round trip yields a read-only, workspace-scoped token', async ({ request }) => {
    const resource = ((await (await request.get('/.well-known/oauth-protected-resource')).json()) as {
      resource: string;
    }).resource;

    const clientId = await registerClient(request);
    const guest = await createGuest(request, 'roundtrip');
    const { verifier, challenge } = pkce();

    // The consent page renders for a signed-in principal.
    const authorizeUrl =
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=read+files&state=e2e-state` +
      `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`;
    const consent = await request.get(authorizeUrl, {
      headers: bearer(guest.sessionToken),
      maxRedirects: 0,
    });
    expect(consent.status()).toBe(200);
    expect(await consent.text()).toContain('Connect to Octo');

    const code = await authorize(request, guest, clientId, resource, challenge, guest.workspace.id);
    const { status, body } = await exchange(request, clientId, code, verifier);
    expect(status).toBe(200);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    const accessToken = body.access_token!;

    // The access token drives the MCP endpoint.
    const init = await request.post('/mcp', {
      headers: mcpHeaders(accessToken),
      data: rpc('initialize', 1, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      }),
    });
    expect(init.status()).toBe(200);

    const list = await request.post('/mcp', {
      headers: mcpHeaders(accessToken),
      data: rpc('tools/list', 2),
    });
    expect(list.status()).toBe(200);
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name
    );
    expect(tools).toContain('list_files');

    // Read is allowed; a write is refused because the token is read-only.
    const read = await request.get(`/api/files?workspaceId=${guest.workspace.id}`, {
      headers: bearer(accessToken),
    });
    expect(read.status()).toBe(200);

    const write = await request.post('/api/files/upload', {
      headers: bearer(accessToken),
      data: { workspaceId: guest.workspace.id, name: 'nope.txt', mimeType: 'text/plain' },
    });
    expect(write.status()).toBe(403);

    // A replayed authorization code redeems nothing.
    const replay = await exchange(request, clientId, code, verifier);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  test('a signed-in browser is resumed at the consent page after the login bounce', async ({ page, request }) => {
    const resource = ((await (await request.get('/.well-known/oauth-protected-resource')).json()) as {
      resource: string;
    }).resource;
    const clientId = await registerClient(request);
    const guest = await createGuest(request, 'browser');
    const { challenge } = pkce();
    const authorizeUrl =
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=read+files&state=e2e-state` +
      `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`;

    // The connector opens /oauth/authorize as a plain navigation, which cannot
    // carry the dashboard's localStorage session. Octo bounces to the dashboard
    // and the dashboard hands the session back as a cookie, so the consent page
    // renders for a real principal instead of an anonymous visitor.
    await page.addInitScript((token) => localStorage.setItem('octo_token', token), guest.sessionToken);
    await page.goto(authorizeUrl);
    await expect(page.getByText('Connect to Octo')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow read access' })).toBeVisible();
  });

  test('the login bounce refuses to redirect off-origin', async ({ page, request }) => {
    const guest = await createGuest(request, 'redirect-guard');
    // The bounce target arrives in the URL hash, so a crafted link must not be
    // able to turn the dashboard into an open redirect for a signed-in visitor.
    await page.addInitScript((token) => localStorage.setItem('octo_token', token), guest.sessionToken);
    await page.goto('/#oauth_return=' + encodeURIComponent('https://evil.example/oauth/authorize'));
    await expect(page).toHaveURL(/localhost:3000\/$/);
    // The workspace name is the shell's h1 and the overview's h2, so match the first.
    await expect(page.getByRole('heading', { name: 'Personal (Guest)' }).first()).toBeVisible();
  });

  test('a wrong PKCE verifier is refused', async ({ request }) => {
    const resource = ((await (await request.get('/.well-known/oauth-protected-resource')).json()) as {
      resource: string;
    }).resource;
    const clientId = await registerClient(request);
    const guest = await createGuest(request, 'pkce');
    const { challenge } = pkce();
    const code = await authorize(request, guest, clientId, resource, challenge, guest.workspace.id);

    const { verifier: wrongVerifier } = pkce();
    const { status, body } = await exchange(request, clientId, code, wrongVerifier);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  test('the token cannot reach another workspace', async ({ request }) => {
    const resource = ((await (await request.get('/.well-known/oauth-protected-resource')).json()) as {
      resource: string;
    }).resource;
    const clientId = await registerClient(request);
    const guestA = await createGuest(request, 'ws-a');
    const guestB = await createGuest(request, 'ws-b');
    const { verifier, challenge } = pkce();
    const code = await authorize(request, guestA, clientId, resource, challenge, guestA.workspace.id);
    const { body } = await exchange(request, clientId, code, verifier);
    const accessToken = body.access_token!;

    const ownRead = await request.get(`/api/files?workspaceId=${guestA.workspace.id}`, {
      headers: bearer(accessToken),
    });
    expect(ownRead.status()).toBe(200);

    const otherRead = await request.get(`/api/files?workspaceId=${guestB.workspace.id}`, {
      headers: bearer(accessToken),
    });
    expect(otherRead.status()).toBe(403);
  });

  test('consent cannot be granted for a workspace the principal does not own', async ({ request }) => {
    const resource = ((await (await request.get('/.well-known/oauth-protected-resource')).json()) as {
      resource: string;
    }).resource;
    const clientId = await registerClient(request);
    const guestA = await createGuest(request, 'consent-a');
    const guestB = await createGuest(request, 'consent-b');
    const { challenge } = pkce();

    const response = await request.post('/oauth/authorize', {
      headers: bearer(guestA.sessionToken),
      form: {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: 'read files',
        state: 'e2e-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
        workspace_id: guestB.workspace.id,
      },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
  });

  test('refresh rotates, and replaying a rotated token revokes the family', async ({ request }) => {
    const resource = ((await (await request.get('/.well-known/oauth-protected-resource')).json()) as {
      resource: string;
    }).resource;
    const clientId = await registerClient(request);
    const guest = await createGuest(request, 'refresh');
    const { verifier, challenge } = pkce();
    const code = await authorize(request, guest, clientId, resource, challenge, guest.workspace.id);
    const first = await exchange(request, clientId, code, verifier);
    const refreshToken = first.body.refresh_token!;

    const rotated = await request.post('/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    });
    expect(rotated.status()).toBe(200);
    const rotatedBody = (await rotated.json()) as { refresh_token: string; access_token: string };
    expect(rotatedBody.refresh_token).not.toBe(refreshToken);

    // Replaying the now-rotated token is refused...
    const replay = await request.post('/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    });
    expect(replay.status()).toBe(400);

    // ...and it also kills the successor, so a thief cannot keep the session.
    const successor = await request.post('/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: rotatedBody.refresh_token, client_id: clientId },
    });
    expect(successor.status()).toBe(400);
  });

  test('the retired /mcp/<key> form answers 404, and a bearer key still works', async ({ request }) => {
    const guest = await createGuest(request, 'keypath');

    const retired = await request.post('/mcp/octo_live_whatever', {
      headers: mcpHeaders(),
      data: rpc('tools/list', 1),
      maxRedirects: 0,
    });
    expect(retired.status()).toBe(404);

    // The pre-existing bearer-key path is unchanged.
    const withSession = await request.post('/mcp', {
      headers: mcpHeaders(guest.sessionToken),
      data: rpc('tools/list', 2),
    });
    expect(withSession.status()).toBe(200);
  });
});
