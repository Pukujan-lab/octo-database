/**
 * Hidden holdout for the vault cabinet.
 *
 * The public unit tests name the parser and the presenter. This flow does not:
 * a guest stores an account token and a workspace password, each with its own
 * description, mints a 10-hour account grant, and opens it. The account token
 * comes back with its description. The workspace password does not. A decoy
 * minted from that grant keeps the description and withholds the token. A
 * normal API key is refused at the cabinet.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIRM_SECRET, setConfirmSecret, typeConfirmCode } from './confirm-secret';

interface GuestSession {
  workspace: { id: string };
  sessionToken: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Vault Holdout ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

test.describe('vault grant holdout', () => {
  test('an account grant reads the token, skips the workspace password, and a decoy keeps only the description', async ({
    request,
    page,
  }) => {
    const session = await createGuest(request);
    const tokenSecret = `cf-${randomUUID()}`;
    const passwordSecret = `pw-${randomUUID()}`;
    const tokenDescription = 'Account token for the gravebuster zone. Not the R2 token.';
    const passwordDescription = 'Mailbox password for the studio admin login.';

    const bare = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: { label: 'Bare token', kind: 'token', secret: tokenSecret, confirmSecret: CONFIRM_SECRET },
    });
    expect(bare.status()).toBe(400);

    const barePassword = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: { label: 'Bare password', kind: 'login', secret: passwordSecret, confirmSecret: CONFIRM_SECRET },
    });
    expect(barePassword.status()).toBe(400);

    const storedToken = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: {
        label: 'Cloudflare',
        description: tokenDescription,
        kind: 'token',
        secret: tokenSecret,
        url: 'https://api.cloudflare.com/client/v4',
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(storedToken.status()).toBe(201);

    const storedPassword = await request.post('/api/vault/items', {
      headers: bearer(session.sessionToken),
      data: {
        label: 'Studio mail',
        description: passwordDescription,
        kind: 'login',
        username: 'ada@studio.test',
        secret: passwordSecret,
        workspaceId: session.workspace.id,
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(storedPassword.status()).toBe(201);

    const tooShort = await request.post('/api/vault/grants', {
      headers: bearer(session.sessionToken),
      data: { name: 'too short', expiresInHours: 4, confirmSecret: CONFIRM_SECRET },
    });
    expect(tooShort.status()).toBe(400);

    const minted = await request.post('/api/vault/grants', {
      headers: bearer(session.sessionToken),
      data: { name: 'event', expiresInHours: 10, confirmSecret: CONFIRM_SECRET },
    });
    expect(minted.status()).toBe(201);
    const { rawSecret } = (await minted.json()) as { rawSecret: string };
    expect(rawSecret.startsWith('octo_vault_')).toBe(true);

    const opened = await request.get('/api/vault/open', { headers: bearer(rawSecret) });
    expect(opened.status()).toBe(200);
    const cabinet = (await opened.json()) as {
      cabinet: string;
      items: Array<{ label: string; description: string; secret: string | null; kind: string }>;
    };
    expect(cabinet.cabinet).toBe('account');
    expect(cabinet.items.map((item) => item.label)).toEqual(['Cloudflare']);
    expect(cabinet.items[0]?.description).toBe(tokenDescription);
    expect(cabinet.items[0]?.secret).toBe(tokenSecret);
    expect(JSON.stringify(cabinet)).not.toContain(passwordSecret);
    expect(JSON.stringify(cabinet)).not.toContain(passwordDescription);

    const decoyMint = await request.post('/api/vault/open/decoy', {
      headers: bearer(rawSecret),
      data: { expiresInHours: 5 },
    });
    expect(decoyMint.status()).toBe(201);
    const decoySecret = ((await decoyMint.json()) as { rawSecret: string }).rawSecret;

    const decoyOpen = await request.get('/api/vault/open', { headers: bearer(decoySecret) });
    expect(decoyOpen.status()).toBe(200);
    const decoyBody = await decoyOpen.text();
    const decoyCabinet = JSON.parse(decoyBody) as {
      items: Array<{ description: string; secret: string | null }>;
    };
    expect(decoyCabinet.items[0]?.description).toBe(tokenDescription);
    expect(decoyCabinet.items[0]?.secret).not.toBe(tokenSecret);
    expect(decoyBody).not.toContain(tokenSecret);
    expect(decoyBody.toLowerCase()).not.toContain('decoy');

    const again = await request.get('/api/vault/open', { headers: bearer(decoySecret) });
    const againCabinet = (await again.json()) as { items: Array<{ secret: string | null }> };
    expect(againCabinet.items[0]?.secret).toBe(decoyCabinet.items[0]?.secret);

    const apiKey = await request.post('/api/keys', {
      headers: bearer(session.sessionToken),
      data: {
        name: 'agent',
        workspaceId: session.workspace.id,
        scopes: ['read'],
        confirmSecret: CONFIRM_SECRET,
      },
    });
    expect(apiKey.status()).toBe(201);
    const liveKey = ((await apiKey.json()) as { rawSecret: string }).rawSecret;
    const refused = await request.get('/api/vault/items', { headers: bearer(liveKey) });
    expect(refused.status()).toBe(403);

    await page.goto('/');
    await page.getByTestId('login-guest').click();
    await expect(page.getByTestId('view-vault').or(page.getByTestId('app-nav'))).toBeVisible();
    await page.getByRole('button', { name: 'Keys', exact: true }).click();
    await expect(page.getByTestId('view-vault')).toBeVisible();
    await expect(page.locator('#vault-account-description')).toBeVisible();
    const kind = page.locator('#vault-account-kind');
    await kind.click();
    await page.getByRole('option', { name: 'Login' }).click();
    await expect(page.locator('label[for="vault-account-secret"]')).toHaveText('Password');
    await typeConfirmCode(page);
  });
});
