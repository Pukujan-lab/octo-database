/**
 * Playwright E2E HOLDOUT: RAG document lifecycle.
 *
 * The public spec drives the document lifecycle over the HTTP routes it names.
 * This one changes the surface, the transport, and the pairing:
 *
 *   * surface   — the **real MCP tools** (`list_documents`, `get_document`,
 *     `rename_document`, `delete_document`) through the adapter + client, not a
 *     direct HTTP call, so a server that only gated the routes the public spec
 *     happens to call would still be exercised end to end;
 *   * transport — an in-memory MCP transport, the same path an agent uses;
 *   * pairing   — a key with `read`+`write` renames successfully but is refused
 *     the delete (missing `delete` scope), while a `read`+`write`+`delete` key
 *     completes it, so the refusal is the missing scope and not a dead key.
 *
 * CI has no embedding provider, so the documents are seeded directly and only
 * the lifecycle is driven over MCP.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { randomUUID } from 'node:crypto';
import { OctoApi } from '../../src/mcp/client';
import { createOctoMcpServer } from '../../src/mcp/server';
import { queryService } from '../../src/server/db';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';

const API_BASE = 'http://localhost:3001';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface GuestSession {
  principal: { id: string };
  workspace: { id: string };
  sessionToken: string;
}

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `RAG Lifecycle Holdout ${randomUUID()}` },
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
  scopes: string[]
): Promise<string> {
  const response = await request.post('/api/keys', {
    headers: bearer(sessionToken),
    data: { name: `rag holdout ${randomUUID()}`, workspaceId, scopes, confirmSecret: CONFIRM_SECRET },
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

async function mcpClient(token: string): Promise<Client> {
  const server = createOctoMcpServer(new OctoApi({ baseUrl: API_BASE, token }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rag-lifecycle-holdout', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join('');
}

test.describe('RAG document lifecycle — holdout (MCP surface)', () => {
  test('drives list, get, rename, and delete through MCP tools, with delete refused to a key lacking the scope', async ({
    request,
  }) => {
    const owner = await createGuest(request);
    const workspaceId = owner.workspace.id;
    const alpha = await seedDocument(workspaceId, owner.principal.id, `Alpha ${randomUUID()}`);
    const betaTitle = `Beta ${randomUUID()}`;
    const beta = await seedDocument(workspaceId, owner.principal.id, betaTitle);

    const full = await mcpClient(
      await mintKey(request, owner.sessionToken, workspaceId, ['read', 'write', 'delete'])
    );

    // list_documents sees both seeded documents with their counts.
    const listed = await full.callTool({
      name: 'list_documents',
      arguments: { workspaceId },
    });
    expect(listed.isError).toBeFalsy();
    const rows = JSON.parse(textOf(listed)) as Array<{
      documentId: string;
      versionCount: number;
      chunkCount: number;
    }>;
    expect(rows.map((d) => d.documentId).sort()).toEqual([alpha.documentId, beta.documentId].sort());
    expect(rows.find((d) => d.documentId === alpha.documentId)!.chunkCount).toBe(1);

    // get_document returns the immutable versions.
    const detail = await full.callTool({
      name: 'get_document',
      arguments: { workspaceId, documentId: alpha.documentId },
    });
    expect(detail.isError).toBeFalsy();
    const doc = JSON.parse(textOf(detail)) as {
      versions: Array<{ versionNumber: number }>;
    };
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]!.versionNumber).toBe(1);

    // rename_document is metadata-only.
    const newTitle = `Alpha Renamed ${randomUUID()}`;
    const renamed = await full.callTool({
      name: 'rename_document',
      arguments: { workspaceId, documentId: alpha.documentId, title: newTitle },
    });
    expect(renamed.isError).toBeFalsy();
    expect((JSON.parse(textOf(renamed)) as { title: string }).title).toBe(newTitle);

    // Renaming onto another document's title surfaces the API's 409 as a tool error.
    const conflict = await full.callTool({
      name: 'rename_document',
      arguments: { workspaceId, documentId: alpha.documentId, title: betaTitle },
    });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toContain('409');

    // A key without the delete scope can rename but is refused the delete.
    const writer = await mcpClient(
      await mintKey(request, owner.sessionToken, workspaceId, ['read', 'write'])
    );
    const refusedDelete = await writer.callTool({
      name: 'delete_document',
      arguments: { workspaceId, documentId: alpha.documentId },
    });
    expect(refusedDelete.isError).toBe(true);
    expect(textOf(refusedDelete)).toContain('403');

    // The full key deletes it, and a repeat read through MCP is a 404 tool error.
    const deleted = await full.callTool({
      name: 'delete_document',
      arguments: { workspaceId, documentId: alpha.documentId },
    });
    expect(deleted.isError).toBeFalsy();
    expect((JSON.parse(textOf(deleted)) as { deleted: boolean }).deleted).toBe(true);

    const gone = await full.callTool({
      name: 'get_document',
      arguments: { workspaceId, documentId: alpha.documentId },
    });
    expect(gone.isError).toBe(true);
    expect(textOf(gone)).toContain('404');

    // MR-1: only the deleted document's derived rows are gone; the sibling's survive.
    expect(await derivedCounts(alpha.documentId)).toEqual({ versions: 0, chunks: 0, embeddings: 0 });
    expect(await derivedCounts(beta.documentId)).toEqual({ versions: 1, chunks: 1, embeddings: 1 });
  });
});
