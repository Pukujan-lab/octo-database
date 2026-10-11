/**
 * Playwright E2E: Workspace-scoped key pinning across every route (defect #1)
 *
 * A workspace-scoped key (`octo_live_ws_...`) is minted against one workspace and
 * must not be usable against another. The catalog/upload routes enforce that with
 * `keyWorkspaceMatches`; six sibling routes (share create/list/revoke, manual job
 * retry, RAG ingest/query) checked membership only, so a key bound to workspace A
 * could act on any workspace its principal also owned. This drives all six against
 * a real server + database and proves each now refuses the wrong workspace with
 * 403 -- while the same key still works on its own workspace, so the refusals are
 * the pin and not a dead key.
 */

import { expect, test } from '@playwright/test';
import { exemptFromDailyLimit } from './workspace-quota';

test.describe('Workspace-scoped key pinning', () => {
  test('a key bound to one workspace is refused on another across shares, jobs, and RAG', async ({
    page,
  }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    // Pinning is orthogonal to the daily creation limit, which would refuse the
    // second workspace; exempt this fixture so both are created in one run.
    await exemptFromDailyLimit(page);

    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('octo_token');
      const sessionHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };
      // Creating a workspace and minting a key both require the human stamp.
      await fetch('/api/me/confirm-secret', {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ secret: 'e2e-confirm-secret' }),
      });

      const createWorkspace = async (name: string) =>
        (await (
          await fetch('/api/workspaces', {
            method: 'POST',
            headers: sessionHeaders,
            body: JSON.stringify({ name, confirmSecret: 'e2e-confirm-secret' }),
          })
        ).json()) as { workspace: { id: string } };

      const a = await createWorkspace(`Pinned A ${Date.now()}`);
      const b = await createWorkspace(`Pinned B ${Date.now()}`);

      // A key bound to workspace A, with scopes broad enough to reach every route.
      const minted = (await (
        await fetch('/api/keys', {
          method: 'POST',
          headers: sessionHeaders,
          body: JSON.stringify({
            name: 'pinning key',
            workspaceId: a.workspace.id,
            scopes: ['read', 'write', 'files', 'delete'],
            confirmSecret: 'e2e-confirm-secret',
          }),
        })
      ).json()) as { rawSecret: string };
      const keyHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${minted.rawSecret}`,
      };

      // Every call targets workspace B while the key is bound to A.
      const shareOnB = await fetch('/api/workspaces/shares', {
        method: 'POST',
        headers: keyHeaders,
        body: JSON.stringify({ workspaceId: b.workspace.id }),
      });
      const listOnB = await fetch(`/api/workspaces/shares?workspaceId=${b.workspace.id}`, {
        headers: keyHeaders,
      });
      const revokeOnB = await fetch(`/api/shares/${a.workspace.id}?workspaceId=${b.workspace.id}`, {
        method: 'DELETE',
        headers: keyHeaders,
      });
      const retryOnB = await fetch(
        `/api/jobs/${a.workspace.id}/retry?workspaceId=${b.workspace.id}`,
        { method: 'POST', headers: keyHeaders }
      );
      const ingestOnB = await fetch('/api/rag/documents', {
        method: 'POST',
        headers: keyHeaders,
        body: JSON.stringify({ workspaceId: b.workspace.id, title: 'pinned', text: 'body' }),
      });
      const queryOnB = await fetch('/api/rag/query', {
        method: 'POST',
        headers: keyHeaders,
        body: JSON.stringify({ workspaceId: b.workspace.id, query: 'pinned' }),
      });

      // Control: the same key on its own workspace must still be honored, so a
      // 403 above can only be the pin, never a revoked or broken key.
      const shareOnOwn = await fetch('/api/workspaces/shares', {
        method: 'POST',
        headers: keyHeaders,
        body: JSON.stringify({ workspaceId: a.workspace.id }),
      });
      const listOnOwn = await fetch(`/api/workspaces/shares?workspaceId=${a.workspace.id}`, {
        headers: keyHeaders,
      });

      return {
        shareOnB: shareOnB.status,
        listOnB: listOnB.status,
        revokeOnB: revokeOnB.status,
        retryOnB: retryOnB.status,
        ingestOnB: ingestOnB.status,
        queryOnB: queryOnB.status,
        shareOnOwn: shareOnOwn.status,
        listOnOwn: listOnOwn.status,
      };
    });

    expect(result.shareOnB).toBe(403);
    expect(result.listOnB).toBe(403);
    expect(result.revokeOnB).toBe(403);
    expect(result.retryOnB).toBe(403);
    expect(result.ingestOnB).toBe(403);
    expect(result.queryOnB).toBe(403);

    expect(result.shareOnOwn).toBe(201);
    expect(result.listOnOwn).toBe(200);
  });
});
