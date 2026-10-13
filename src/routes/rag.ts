/**
 * Retrieval: document ingestion and query.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { embedTexts, loadEmbeddingConfigFromEnv } from '../rag/embeddings';
import { chunkKey, chunkText, contentHash, extractText } from '../rag/pipeline';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbEnsureEmbeddingConfig, dbGetWorkspaceMembership, dbMatchChunks, dbReplaceChunksAndEmbeddings, dbUpsertDocumentVersion, query } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleRagRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 11. Retrieval: ingest and query (Slice 8)
  // Ingest: POST /api/rag/documents
  if (pathname === '/api/rag/documents' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    // Authorize before probing provider configuration: an unauthorized caller
    // must not learn whether embeddings are configured.
    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, title, text, mimeType } = parsed;

    if (!workspaceId || !title || typeof text !== 'string') {
      sendJson(res, 400, { error: 'workspaceId, title, and text are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to ingest documents' });
      return true;
    }

    const embeddingConfig = loadEmbeddingConfigFromEnv();
    if (!embeddingConfig) {
      sendJson(res, 503, {
        error: 'EMBEDDING_PROVIDER_NOT_CONFIGURED: set OCTO_EMBEDDING_API_KEY to ingest documents',
      });
      return true;
    }

    const bytes = Buffer.from(text, 'utf-8');
    const resolvedMime = mimeType ?? 'text/plain';
    const extracted = extractText(resolvedMime, bytes);
    if (extracted === null) {
      sendJson(res, 415, {
        error: `EXTRACTION_UNSUPPORTED: cannot faithfully extract text from ${resolvedMime}`,
      });
      return true;
    }

    const hash = contentHash(bytes);
    const configId = await dbEnsureEmbeddingConfig(
      workspaceId,
      embeddingConfig.model,
      'v1',
      embeddingConfig.dimensions,
      'paragraph-aware',
      800,
      100
    );

    const version = await dbUpsertDocumentVersion(
      workspaceId,
      title,
      hash,
      resolvedMime,
      bytes.byteLength,
      extracted,
      auth.principal.id
    );

    // Re-ingesting identical bytes is a no-op beyond the version lookup.
    if (!version.created) {
      sendJson(res, 200, {
        documentId: version.documentId,
        versionId: version.versionId,
        created: false,
        message: 'Identical content already ingested; no new version created.',
      });
      return true;
    }

    const chunks = chunkText(extracted, {
      model: embeddingConfig.model,
      modelVersion: 'v1',
      dimensions: embeddingConfig.dimensions,
      chunker: 'paragraph-aware',
      chunkSize: 800,
      chunkOverlap: 100,
    }).map((c) => ({
      ...c,
      chunkKey: chunkKey(version.versionId, configId, c.chunkIndex),
    }));

    const { vectors } = await embedTexts(embeddingConfig, chunks.map((c) => c.content));
    const written = await dbReplaceChunksAndEmbeddings(
      workspaceId,
      version.versionId,
      configId,
      chunks,
      vectors
    );

    sendJson(res, 201, {
      documentId: version.documentId,
      versionId: version.versionId,
      contentHash: hash,
      chunks: written,
      embedding: { model: embeddingConfig.model, dimensions: embeddingConfig.dimensions },
      created: true,
    });
    return true;
  }

  // Query: POST /api/rag/query
  if (pathname === '/api/rag/query' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, query, limit } = parsed;

    if (!workspaceId || !query) {
      sendJson(res, 400, { error: 'workspaceId and query are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    // Authorize before probing provider configuration: an unauthorized caller
    // must not learn whether embeddings are configured.
    const embeddingConfig = loadEmbeddingConfigFromEnv();
    if (!embeddingConfig) {
      sendJson(res, 503, {
        error: 'EMBEDDING_PROVIDER_NOT_CONFIGURED: set OCTO_EMBEDDING_API_KEY to query documents',
      });
      return true;
    }

    const { vectors } = await embedTexts(embeddingConfig, [query]);
    const results = await dbMatchChunks(workspaceId, vectors[0]!, limit ?? 10, 0);

    sendJson(res, 200, {
      query,
      matches: results,
      // Provenance: each match carries the version and the exact embedding/chunker
      // configuration that produced it.
    });
    return true;
  }

  return false;
}
