/**
 * Retrieval: document ingestion and query.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { embedTexts, loadEmbeddingConfigFromEnv } from '../rag/embeddings';
import { RAG_CHUNKER, RAG_CHUNK_OVERLAP, RAG_CHUNK_SIZE, RAG_MODEL_VERSION, embedInBatches, ragChunkConfig } from '../rag/ingest';
import { chunkKey, chunkText, contentHash, extractText } from '../rag/pipeline';
import { loadRerankConfigFromEnv, rerankCandidateCount, rerankScores } from '../rag/rerank';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbDeleteDocument, dbEnqueueJob, dbEnsureEmbeddingConfig, dbGetArchiveRecord, dbGetDocument, dbGetWorkspaceMembership, dbListDocuments, dbMatchChunksHybrid, dbRenameDocument, dbReplaceChunksAndEmbeddings, dbUpsertDocumentVersion, query } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { attributeAgentAction } from '../server/ops';
import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const { workspaceId, title, text, mimeType, fileId } = parsed;

    if (!workspaceId || (!fileId && (!title || typeof text !== 'string'))) {
      sendJson(res, 400, { error: 'workspaceId and either fileId, or title and text, are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (fileId && !requireUuid(res, fileId, 'fileId')) return true;

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
        error: 'EMBEDDING_PROVIDER_NOT_CONFIGURED: set OCTO_EMBEDDING_BASE_URL and OCTO_EMBEDDING_MODEL to ingest documents',
      });
      return true;
    }

    // An uploaded file (PDF, text) is indexed by the queue worker: reading a PDF
    // page by page can take minutes, so the caller gets the job to poll.
    if (fileId) {
      const file = await dbGetArchiveRecord(workspaceId, fileId);
      if (!file) {
        sendJson(res, 404, { error: 'NOT_FOUND: file not found in this workspace' });
        return true;
      }
      const { job } = await dbEnqueueJob(
        randomUUID(),
        workspaceId,
        'rag_ingest_file',
        `rag:${fileId}:${randomUUID()}`,
        { fileId, ...(typeof title === 'string' && title ? { title } : {}) },
        auth.principal.id
      );
      sendJson(res, 202, { jobId: job.id, state: job.state, fileId });
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
      RAG_MODEL_VERSION,
      embeddingConfig.dimensions,
      RAG_CHUNKER,
      RAG_CHUNK_SIZE,
      RAG_CHUNK_OVERLAP
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

    const chunks = chunkText(extracted, ragChunkConfig(embeddingConfig)).map((c) => ({
      ...c,
      chunkKey: chunkKey(version.versionId, configId, c.chunkIndex),
    }));

    const vectors = await embedInBatches(embeddingConfig, chunks.map((c) => c.content));
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
    const { workspaceId, query, limit, filter, rerank } = parsed;

    if (!workspaceId || !query) {
      sendJson(res, 400, { error: 'workspaceId and query are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (rerank !== undefined && typeof rerank !== 'boolean') {
      sendJson(res, 400, { error: 'rerank must be a boolean' });
      return true;
    }

    // Optional filter (issue #364), applied inside the search before its limit.
    const documentIds = filter?.documentIds;
    const titlePrefix = filter?.titlePrefix;
    const latestVersionOnly = filter?.latestVersionOnly;
    if (
      (filter !== undefined && (typeof filter !== 'object' || filter === null || Array.isArray(filter))) ||
      (documentIds !== undefined &&
        (!Array.isArray(documentIds) || !documentIds.every((id: unknown) => typeof id === 'string' && UUID_RE.test(id)))) ||
      (titlePrefix !== undefined && typeof titlePrefix !== 'string') ||
      (latestVersionOnly !== undefined && typeof latestVersionOnly !== 'boolean')
    ) {
      sendJson(res, 400, {
        error: 'filter must be { documentIds?: uuid[], titlePrefix?: string, latestVersionOnly?: boolean }',
      });
      return true;
    }

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
        error: 'EMBEDDING_PROVIDER_NOT_CONFIGURED: set OCTO_EMBEDDING_BASE_URL and OCTO_EMBEDDING_MODEL to query documents',
      });
      return true;
    }

    // Rerank is on by default wherever a reranker is configured; `rerank: false`
    // skips it, and an explicit `rerank: true` without one is an error.
    const rerankConfig = rerank === false ? null : loadRerankConfigFromEnv();
    if (rerank === true && !rerankConfig) {
      sendJson(res, 503, { error: 'RERANK_NOT_CONFIGURED: set OCTO_RERANK_URL to rerank results' });
      return true;
    }

    const matchLimit = limit ?? 10;
    const { vectors } = await embedTexts(embeddingConfig, [query]);
    let results: Array<Awaited<ReturnType<typeof dbMatchChunksHybrid>>[number] & { rerankScore?: number }> =
      await dbMatchChunksHybrid(
        workspaceId,
        query,
        vectors[0]!,
        rerankConfig ? rerankCandidateCount(matchLimit) : matchLimit,
        { documentIds, titlePrefix, latestVersionOnly }
      );

    // Rerank (issue #365): re-score the wider candidate set, then cut to
    // the limit. When no reranker answers, the hybrid order is kept.
    let reranked = false;
    if (rerankConfig) {
      const scores = await rerankScores(rerankConfig, query, results.map((r) => r.content));
      if (scores) {
        results = results
          .map((r, i) => ({ ...r, rerankScore: scores[i]! }))
          .sort((a, b) => b.rerankScore - a.rerankScore);
        reranked = true;
      }
      results = results.slice(0, matchLimit);
    }

    sendJson(res, 200, {
      query,
      // Hybrid: a lexical (full-text) arm and a vector arm, fused with RRF. Each
      // match reports which arms found it -- `similarity` is null for a chunk only
      // the lexical arm returned, `lexicalScore` null for a vector-only match.
      mode: 'hybrid',
      ...(rerankConfig ? { reranked } : {}),
      matches: results,
      // Provenance: each match carries its document, title, version, page (PDFs),
      // and the exact embedding/chunker configuration that produced it.
    });
    return true;
  }

  // Document lifecycle: list, get, rename, delete. Edit is rename only -- a
  // document's versions are immutable and content-hashed, so changing the text is
  // a re-ingest (a new version), never an in-place rewrite.

  // List: GET /api/rag/documents?workspaceId=<id>
  if (pathname === '/api/rag/documents' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' });
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

    sendJson(res, 200, await dbListDocuments(workspaceId));
    return true;
  }

  if (pathname.startsWith('/api/rag/documents/')) {
    const rest = pathname.slice('/api/rag/documents/'.length);
    const isRename = rest.endsWith('/rename');
    const documentId = isRename ? rest.slice(0, -'/rename'.length) : rest;

    // Get one with its versions: GET /api/rag/documents/<id>?workspaceId=<id>
    if (!isRename && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return true;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return true;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return true;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
      if (!requireUuid(res, documentId, 'documentId')) return true;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return true;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return true;
      }

      const doc = await dbGetDocument(workspaceId, documentId);
      if (!doc) {
        sendJson(res, 404, { error: 'DOCUMENT_NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, doc);
      return true;
    }

    // Rename: POST /api/rag/documents/<id>/rename  body {workspaceId, title}
    if (isRename && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return true;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return true;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, title } = parsed;
      if (!workspaceId || typeof title !== 'string' || title.trim() === '') {
        sendJson(res, 400, { error: 'workspaceId and a non-empty title are required' });
        return true;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
      if (!requireUuid(res, documentId, 'documentId')) return true;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return true;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to rename documents' });
        return true;
      }

      try {
        const renamed = await dbRenameDocument(workspaceId, documentId, title);
        if (!renamed) {
          sendJson(res, 404, { error: 'DOCUMENT_NOT_FOUND' });
          return true;
        }
        await attributeAgentAction(auth, workspaceId, 'document.renamed', `Document ${documentId} renamed`);
        sendJson(res, 200, renamed);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          sendJson(res, 409, { error: 'DOCUMENT_TITLE_EXISTS' });
          return true;
        }
        throw err;
      }
      return true;
    }

    // Delete a document and its derived rows: DELETE /api/rag/documents/<id>?workspaceId=<id>
    if (!isRename && req.method === 'DELETE') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return true;
      }
      if (!requireScope(auth, 'delete')) {
        scopeDenied(res, 'delete');
        return true;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return true;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
      if (!requireUuid(res, documentId, 'documentId')) return true;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return true;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to delete documents' });
        return true;
      }

      const deleted = await dbDeleteDocument(workspaceId, documentId);
      if (!deleted) {
        sendJson(res, 404, { error: 'DOCUMENT_NOT_FOUND' });
        return true;
      }
      await attributeAgentAction(auth, workspaceId, 'document.deleted', `Document ${documentId} deleted`);
      sendJson(res, 200, { documentId: deleted.documentId, deleted: true });
      return true;
    }
  }

  return false;
}
