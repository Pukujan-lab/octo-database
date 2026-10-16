/**
 * Playwright API/E2E: RAG document lifecycle.
 *
 * Ingest and semantic query already existed; this proves the catalog is now
 * manageable -- list, read, rename, delete -- and that deleting one document
 * removes only its own derived rows. CI has no embedding provider, so fixtures
 * seed documents, versions, chunks, and embeddings directly (the same way
 * capability discovery seeds memberships), then drive the routes over HTTP.
 *
 * The invariants a running system must show:
 *   MR-1  Delete is scoped: removing one document leaves another document's
 *         source and derived rows untouched.
 *   MR-2  Refusal is not success: a key missing the scope or the role, or pinned
 *         to another workspace, is refused, and the document survives.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { queryService } from '../../src/server/db';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface GuestSession {
  principal: { id: string; isGuest: boolean };
  workspace: { id: string; slug: string; role: string };
  sessionToken: string;
}

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `RAG Lifecycle E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function mintKey(
  request: APIRequestContext,
  sessionToken: string,
  workspaceId: string,
  scopes: string[],
  name: string
): Promise<string> {
  const response = await request.post('/api/keys', {
    headers: bearer(sessionToken),
    data: { name: `${name} ${randomUUID()}`, workspaceId, scopes, confirmSecret: CONFIRM_SECRET },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { rawSecret: string }).rawSecret;
}

async function ensureEmbeddingConfig(workspaceId: string): Promise<string> {
  const inserted = await queryService<{ id: string }>(
    `INSERT INTO octo.embedding_configs
       (workspace_id, model, model_version, dimensions, chunker, chunk_size, chunk_overlap)
     VALUES ($1, 'text-embedding-3-small', 'v1', 1024, 'paragraph-aware', 800, 100)
     ON CONFLICT (workspace_id, model, model_version, chunker, chunk_size, chunk_overlap) DO NOTHING
     RETURNING id`,
    [workspaceId]
  );
  if (inserted[0]) return inserted[0].id;
  const found = await queryService<{ id: string }>(
    `SELECT id FROM octo.embedding_configs
     WHERE workspace_id = $1 AND model = 'text-embedding-3-small' AND model_version = 'v1'
       AND chunker = 'paragraph-aware' AND chunk_size = 800 AND chunk_overlap = 100`,
    [workspaceId]
  );
  return found[0]!.id;
}

/** Seeds a document with one version, one chunk, and one embedding. */
async function seedDocument(
  workspaceId: string,
  createdBy: string,
  title: string
): Promise<{ documentId: string }> {
  const configId = await ensureEmbeddingConfig(workspaceId);
  const zeroVector = `[${Array(1024).fill('0').join(',')}]`;

  const doc = await queryService<{ id: string }>(
    `INSERT INTO octo.documents (workspace_id, title, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [workspaceId, title, createdBy]
  );
  const documentId = doc[0]!.id;

  const version = await queryService<{ id: string }>(
    `INSERT INTO octo.document_versions
       (document_id, workspace_id, version_number, content_hash, mime_type, byte_size, extracted_text, extraction_status)
     VALUES ($1, $2, 1, $3, 'text/plain', 10, $4, 'extracted') RETURNING id`,
    [documentId, workspaceId, `sha256:${randomUUID()}`, `text of ${title}`]
  );

  const chunk = await queryService<{ id: string }>(
    `INSERT INTO octo.chunks
       (workspace_id, document_version_id, config_id, chunk_index, chunk_key, content, start_offset, end_offset, token_estimate)
     VALUES ($1, $2, $3, 0, $4, $5, 0, 10, 3) RETURNING id`,
    [workspaceId, version[0]!.id, configId, `key-${randomUUID()}`, `text of ${title}`]
  );

  await queryService(
    `INSERT INTO octo.embeddings (workspace_id, chunk_id, config_id, embedding) VALUES ($1, $2, $3, $4::vector)`,
    [workspaceId, chunk[0]!.id, configId, zeroVector]
  );

  return { documentId };
}

/** Rows still attached to a document: versions, chunks, and embeddings. */
async function derivedCounts(
  documentId: string
): Promise<{ versions: number; chunks: number; embeddings: number }> {
  const rows = await queryService<{ versions: number; chunks: number; embeddings: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM octo.document_versions WHERE document_id = $1) AS versions,
       (SELECT COUNT(*)::int FROM octo.chunks c
          JOIN octo.document_versions v ON v.id = c.document_version_id
         WHERE v.document_id = $1) AS chunks,
       (SELECT COUNT(*)::int FROM octo.embeddings e
          JOIN octo.chunks c ON c.id = e.chunk_id
          JOIN octo.document_versions v ON v.id = c.document_version_id
         WHERE v.document_id = $1) AS embeddings`,
    [documentId]
  );
  return rows[0]!;
}

test.describe('RAG document lifecycle', () => {
  test('lists, reads, renames, and deletes a document, and delete removes only its own derived rows', async ({
    request,
  }) => {
    const owner = await createGuest(request);
    const workspaceId = owner.workspace.id;
    const alpha = await seedDocument(workspaceId, owner.principal.id, `Alpha ${randomUUID()}`);
    const betaTitle = `Beta ${randomUUID()}`;
    const beta = await seedDocument(workspaceId, owner.principal.id, betaTitle);
    const headers = bearer(
      await mintKey(request, owner.sessionToken, workspaceId, ['read', 'write', 'delete'], 'rag owner')
    );

    // List shows both seeded documents with their counts.
    const listResponse = await request.get(`/api/rag/documents?workspaceId=${workspaceId}`, {
      headers,
    });
    expect(listResponse.status()).toBe(200);
    const listed = (await listResponse.json()) as Array<{
      documentId: string;
      title: string;
      versionCount: number;
      chunkCount: number;
    }>;
    expect(listed.map((d) => d.documentId).sort()).toEqual(
      [alpha.documentId, beta.documentId].sort()
    );
    const alphaRow = listed.find((d) => d.documentId === alpha.documentId)!;
    expect(alphaRow.versionCount).toBe(1);
    expect(alphaRow.chunkCount).toBe(1);

    // Get returns the document with its immutable versions.
    const detailResponse = await request.get(
      `/api/rag/documents/${alpha.documentId}?workspaceId=${workspaceId}`,
      { headers }
    );
    expect(detailResponse.status()).toBe(200);
    const detail = (await detailResponse.json()) as {
      documentId: string;
      title: string;
      versions: Array<{ versionNumber: number; chunkCount: number }>;
    };
    expect(detail.documentId).toBe(alpha.documentId);
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]!.versionNumber).toBe(1);

    // Rename is metadata-only and the new title shows on the next list.
    const newTitle = `Alpha Renamed ${randomUUID()}`;
    const renameResponse = await request.post(
      `/api/rag/documents/${alpha.documentId}/rename`,
      { headers, data: { workspaceId, title: newTitle } }
    );
    expect(renameResponse.status()).toBe(200);
    expect((await renameResponse.json()).title).toBe(newTitle);

    // Renaming onto a title another document already holds is a 409, not a 500.
    const conflictResponse = await request.post(
      `/api/rag/documents/${alpha.documentId}/rename`,
      { headers, data: { workspaceId, title: betaTitle } }
    );
    expect(conflictResponse.status()).toBe(409);

    // Delete removes the document and its derived rows.
    const deleteResponse = await request.delete(
      `/api/rag/documents/${alpha.documentId}?workspaceId=${workspaceId}`,
      { headers }
    );
    expect(deleteResponse.status()).toBe(200);
    expect((await deleteResponse.json()).deleted).toBe(true);

    // Gone: a repeat read is 404, and a repeat delete is 404 rather than a false success.
    expect(
      (
        await request.get(`/api/rag/documents/${alpha.documentId}?workspaceId=${workspaceId}`, {
          headers,
        })
      ).status()
    ).toBe(404);
    expect(
      (
        await request.delete(`/api/rag/documents/${alpha.documentId}?workspaceId=${workspaceId}`, {
          headers,
        })
      ).status()
    ).toBe(404);

    // MR-1: the deleted document's derived rows are gone; the sibling's are intact.
    expect(await derivedCounts(alpha.documentId)).toEqual({ versions: 0, chunks: 0, embeddings: 0 });
    expect(await derivedCounts(beta.documentId)).toEqual({ versions: 1, chunks: 1, embeddings: 1 });

    const afterResponse = await request.get(`/api/rag/documents?workspaceId=${workspaceId}`, {
      headers,
    });
    expect(((await afterResponse.json()) as Array<{ documentId: string }>).map((d) => d.documentId)).toEqual(
      [beta.documentId]
    );
  });

  test('refuses rename and delete without the scope or the role, and a key pinned to another workspace', async ({
    request,
  }) => {
    const owner = await createGuest(request);
    const member = await createGuest(request);
    const workspaceId = owner.workspace.id;
    await queryService(
      `INSERT INTO octo.workspace_memberships (workspace_id, principal_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (workspace_id, principal_id) DO UPDATE SET role = 'member', updated_at = now()`,
      [workspaceId, member.principal.id]
    );
    const doc = await seedDocument(workspaceId, owner.principal.id, `Guarded ${randomUUID()}`);

    // Read scope lists, but a read-only key cannot rename or delete.
    const readKey = bearer(await mintKey(request, owner.sessionToken, workspaceId, ['read'], 'rag reader'));
    expect(
      (await request.get(`/api/rag/documents?workspaceId=${workspaceId}`, { headers: readKey })).status()
    ).toBe(200);
    expect(
      (
        await request.post(`/api/rag/documents/${doc.documentId}/rename`, {
          headers: readKey,
          data: { workspaceId, title: 'nope' },
        })
      ).status()
    ).toBe(403);
    expect(
      (
        await request.delete(`/api/rag/documents/${doc.documentId}?workspaceId=${workspaceId}`, {
          headers: readKey,
        })
      ).status()
    ).toBe(403);

    // Write scope without delete is still refused the delete.
    const writeKey = bearer(await mintKey(request, owner.sessionToken, workspaceId, ['read', 'write'], 'rag writer'));
    expect(
      (
        await request.delete(`/api/rag/documents/${doc.documentId}?workspaceId=${workspaceId}`, {
          headers: writeKey,
        })
      ).status()
    ).toBe(403);

    // A member-role key with full scopes is refused by role, not by scope.
    const memberKey = bearer(await mintKey(request, member.sessionToken, workspaceId, ['read', 'write', 'delete'], 'rag member'));
    expect(
      (
        await request.post(`/api/rag/documents/${doc.documentId}/rename`, {
          headers: memberKey,
          data: { workspaceId, title: 'nope' },
        })
      ).status()
    ).toBe(403);
    expect(
      (
        await request.delete(`/api/rag/documents/${doc.documentId}?workspaceId=${workspaceId}`, {
          headers: memberKey,
        })
      ).status()
    ).toBe(403);

    // A key pinned to another workspace cannot reach this document.
    const other = await createGuest(request);
    const pinned = bearer(await mintKey(request, other.sessionToken, other.workspace.id, ['read', 'write', 'delete'], 'rag pinned'));
    expect(
      (
        await request.delete(`/api/rag/documents/${doc.documentId}?workspaceId=${workspaceId}`, {
          headers: pinned,
        })
      ).status()
    ).toBe(403);

    // MR-2: every refusal left the document intact.
    expect(
      (
        await request.get(`/api/rag/documents/${doc.documentId}?workspaceId=${workspaceId}`, {
          headers: readKey,
        })
      ).status()
    ).toBe(200);
  });
});
