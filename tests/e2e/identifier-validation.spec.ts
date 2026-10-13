/**
 * Playwright API/E2E: identifier validation.
 *
 * A path or query identifier that is not a UUID must be refused with a clean 400
 * before it reaches a database call. Otherwise Postgres raises 22P02 and the
 * outer handler answers 500 with raw database text — a wrong status for a client
 * mistake, and a leak of internal detail. This extends the capability-discovery
 * `INVALID_WORKSPACE_ID` contract to the file, gallery, activity, job, share, and
 * RAG document routes.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const NOT_A_UUID = 'not-a-uuid';

interface GuestSession {
  workspace: { id: string };
  sessionToken: string;
}

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Identifier E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as GuestSession;
}

test.describe('Identifier validation', () => {
  test('a malformed workspace, file, job, or share id is a clean 400, never a 500', async ({
    request,
  }) => {
    const { workspace, sessionToken } = await createGuest(request);
    const headers = bearer(sessionToken);
    const workspaceId = workspace.id;

    const cases: Array<{ method: 'get' | 'post' | 'delete'; path: string; data?: unknown }> = [
      { method: 'get', path: `/api/files?workspaceId=${NOT_A_UUID}` },
      { method: 'get', path: `/api/gallery?workspaceId=${NOT_A_UUID}` },
      { method: 'get', path: `/api/activity?workspaceId=${NOT_A_UUID}` },
      { method: 'get', path: `/api/jobs?workspaceId=${NOT_A_UUID}` },
      { method: 'get', path: `/api/workspaces/shares?workspaceId=${NOT_A_UUID}` },
      { method: 'get', path: `/api/files/download?fileId=${NOT_A_UUID}&workspaceId=${workspaceId}` },
      { method: 'delete', path: `/api/files/${NOT_A_UUID}?workspaceId=${workspaceId}` },
      { method: 'post', path: `/api/files/${NOT_A_UUID}/archive?workspaceId=${workspaceId}` },
      { method: 'post', path: `/api/jobs/${NOT_A_UUID}/retry?workspaceId=${workspaceId}` },
      { method: 'delete', path: `/api/shares/${NOT_A_UUID}?workspaceId=${workspaceId}` },
      { method: 'get', path: `/api/rag/documents?workspaceId=${NOT_A_UUID}` },
      { method: 'get', path: `/api/rag/documents/${NOT_A_UUID}?workspaceId=${workspaceId}` },
      {
        method: 'post',
        path: `/api/rag/documents/${NOT_A_UUID}/rename`,
        data: { workspaceId, title: 'whatever' },
      },
      { method: 'delete', path: `/api/rag/documents/${NOT_A_UUID}?workspaceId=${workspaceId}` },
    ];

    for (const { method, path, data } of cases) {
      const response = await request[method](path, { headers, ...(data === undefined ? {} : { data }) });
      expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(400);
      const body = JSON.stringify(await response.json());
      expect(body, `${method.toUpperCase()} ${path} leaked database detail`).not.toMatch(
        /22P02|invalid input syntax|syntax for type uuid/i
      );
    }
  });
});
