/**
 * Playwright E2E: Agent tokens and capability discovery (Slice 7)
 *
 * Proves in a real browser that an agent token's authority is bounded by its
 * scopes: it can discover capabilities and read, but destructive actions are
 * refused, and revocation takes effect immediately.
 */

import { expect, test } from '@playwright/test';

test.describe('Agent tokens', () => {
  test('read-only agent token is scoped, attributable, and revocable', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const workspaces = await (await fetch('/api/workspaces', { headers })).json();
      const workspaceId = workspaces[0].id;

      // Minting requires the human stamp: arm the confirmation gate first.
      await fetch('/api/me/confirm-secret', {
        method: 'POST',
        headers,
        body: JSON.stringify({ secret: 'e2e-confirm-secret' }),
      });

      // Mint a read-only agent token (no write, no delete).
      const minted = await (
        await fetch('/api/keys', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: 'e2e read-only agent',
            workspaceId,
            scopes: ['read', 'files'],
            confirmSecret: 'e2e-confirm-secret',
          }),
        })
      ).json();
      const agent = minted.rawSecret as string;

      const agentHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${agent}` };

      // Capability discovery must be filtered to the granted scopes.
      const capsRes = await fetch('/api/capabilities', { headers: agentHeaders });
      const caps = await capsRes.json();
      const actions = caps.capabilities.map((c: { action: string }) => c.action);

      // Reading is allowed.
      const listStatus = (await fetch(`/api/files?workspaceId=${workspaceId}`, { headers: agentHeaders })).status;

      // Destructive and write actions are refused.
      const deleteStatus = (
        await fetch(`/api/files/00000000-0000-0000-0000-000000000000?workspaceId=${workspaceId}`, {
          method: 'DELETE',
          headers: agentHeaders,
        })
      ).status;

      const uploadStatus = (
        await fetch('/api/files/upload', {
          method: 'POST',
          headers: agentHeaders,
          body: JSON.stringify({
            workspaceId,
            name: 'forbidden.txt',
            mimeType: 'text/plain',
            data: 'nope',
            dataEncoding: 'utf8',
          }),
        })
      ).status;

      // Revoke, then confirm the token stops working entirely.
      await fetch(`/api/keys/${minted.apiKey.id}`, { method: 'DELETE', headers });
      const afterRevoke = (await fetch(`/api/files?workspaceId=${workspaceId}`, { headers: agentHeaders })).status;

      // No infrastructure credential appears anywhere in the discovery payload.
      const serialized = JSON.stringify(caps);

      return { actions, listStatus, deleteStatus, uploadStatus, afterRevoke, serialized };
    });

    // Discovery is filtered: no destructive capability is advertised.
    expect(result.actions).toContain('workspaces.list');
    expect(result.actions).toContain('files.list');
    expect(result.actions).not.toContain('files.delete');
    expect(result.actions).not.toContain('files.upload');

    // Reads succeed; writes and deletes are refused with 403.
    expect(result.listStatus).toBe(200);
    expect(result.deleteStatus).toBe(403);
    expect(result.uploadStatus).toBe(403);

    // Revocation takes effect immediately.
    expect(result.afterRevoke).toBe(401);

    // No provider, database, or service credential is disclosed.
    expect(result.serialized).not.toMatch(/CLOUDFLARE_SECRET|SERVICE_ROLE|refresh_token/i);
  });

  test('unknown scopes are rejected at mint time', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const workspaces = await (await fetch('/api/workspaces', { headers })).json();
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'bad', workspaceId: workspaces[0].id, scopes: ['root'] }),
      });
      return res.status;
    });

    expect(status).toBe(400);
  });
});
