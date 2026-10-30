/**
 * Turning a source into indexable chunks, and the `rag_ingest_file` job (issue #365).
 *
 * Text sources go through the character chunker. A PDF is read page by page: with a
 * reader configured, each page's Markdown becomes passages (table rows kept with
 * their header) and every passage whose numbers are not on that page's text layer
 * is dropped; without one, each page's text layer is chunked. Every PDF chunk
 * records its page.
 */

import type { ObjectStore } from '../storage/object-store';
import { embedTexts, type EmbeddingConfig } from './embeddings';
import { passages, unknownNumbers } from './passages';
import { readPdf, type ReaderConfig } from './reader';
import { chunkKey, chunkText, contentHash, estimateTokens, extractText, type Chunk, type ChunkConfig } from './pipeline';

// The config identity every ingest path writes. Changing the chunker name is how a
// changed chunker is told apart from rows written by the old one (issue #357).
export const RAG_MODEL_VERSION = 'v1';
export const RAG_CHUNKER = 'paragraph-aware-v2';
export const RAG_PDF_CHUNKER = 'page-passages-v1';
export const RAG_CHUNK_SIZE = 800;
export const RAG_CHUNK_OVERLAP = 100;
const EMBED_BATCH = 32;

export function ragChunkConfig(embedding: EmbeddingConfig, chunker = RAG_CHUNKER): ChunkConfig {
  return {
    model: embedding.model,
    modelVersion: RAG_MODEL_VERSION,
    dimensions: embedding.dimensions,
    chunker,
    chunkSize: RAG_CHUNK_SIZE,
    chunkOverlap: RAG_CHUNK_OVERLAP,
  };
}

export type PagedChunk = Chunk & { page: number | null };

export interface PreparedSource {
  /** The text the chunks index; chunk offsets point into it. */
  extractedText: string;
  chunks: PagedChunk[];
  config: ChunkConfig;
  /** Passages dropped by the number check. */
  flagged: number;
}

export function isPdf(mimeType: string): boolean {
  return mimeType.toLowerCase().split(';')[0]?.trim() === 'application/pdf';
}

/** Whether a file of this type can be indexed for document search. */
export function isIndexable(mimeType: string): boolean {
  return isPdf(mimeType) || extractText(mimeType, Buffer.alloc(0)) !== null;
}

/** Prepares a source for indexing, or returns null when its type cannot be read. */
export async function prepareSource(
  mimeType: string,
  bytes: Buffer,
  embedding: EmbeddingConfig,
  reader: ReaderConfig | null
): Promise<PreparedSource | null> {
  if (!isPdf(mimeType)) {
    const text = extractText(mimeType, bytes);
    if (text === null) return null;
    const config = ragChunkConfig(embedding);
    return {
      extractedText: text,
      chunks: chunkText(text, config).map((c) => ({ ...c, page: null })),
      config,
      flagged: 0,
    };
  }

  const config = ragChunkConfig(embedding, RAG_PDF_CHUNKER);
  const pages = await readPdf(bytes, reader);
  const pieces: Array<{ page: number; text: string }> = [];
  let flagged = 0;

  for (const page of pages) {
    if (page.markdown === null) {
      for (const c of chunkText(page.textLayer, config)) pieces.push({ page: page.page, text: c.content.trim() });
      continue;
    }
    // A scan has no text layer to check against, so its passages are kept as read.
    const checkable = page.textLayer.trim().length > 0;
    for (const p of passages(page.markdown, page.page)) {
      if (checkable && unknownNumbers(p.text, page.textLayer).length > 0) {
        flagged += 1;
        continue;
      }
      // A passage over the chunk size (one very long paragraph) is still split.
      for (const c of chunkText(p.text, config)) pieces.push({ page: p.page, text: c.content });
    }
  }

  let extractedText = '';
  const chunks: PagedChunk[] = [];
  for (const piece of pieces) {
    if (!piece.text) continue;
    if (extractedText) extractedText += '\n\n';
    const startOffset = extractedText.length;
    extractedText += piece.text;
    chunks.push({
      chunkIndex: chunks.length,
      chunkKey: '',
      content: piece.text,
      startOffset,
      endOffset: extractedText.length,
      tokenEstimate: estimateTokens(piece.text),
      page: piece.page,
    });
  }
  return { extractedText, chunks, config, flagged };
}

/** Embeds texts in batches so a long document does not become one huge request. */
export async function embedInBatches(embedding: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const { vectors: batch } = await embedTexts(embedding, texts.slice(i, i + EMBED_BATCH));
    vectors.push(...batch);
  }
  return vectors;
}

export interface RagIngestDeps {
  store: ObjectStore;
  embedding: EmbeddingConfig | null;
  reader: ReaderConfig | null;
  loadFile: (workspaceId: string, fileId: string) => Promise<{ name: string; mimeType: string; storageKey: string } | null>;
  ensureConfig: (workspaceId: string, config: ChunkConfig) => Promise<string>;
  upsertVersion: (input: {
    workspaceId: string;
    title: string;
    contentHash: string;
    mimeType: string;
    byteSize: number;
    extractedText: string;
    fileId: string;
  }) => Promise<{ versionId: string; documentId: string; created: boolean }>;
  replaceChunks: (workspaceId: string, versionId: string, configId: string, chunks: PagedChunk[], vectors: number[][]) => Promise<number>;
}

type IngestResult =
  | { ok: true; detail: string }
  | { ok: false; code: string; summary: string; retryable?: boolean };

/**
 * Indexes one uploaded file. The payload carries the file id only; the file record
 * pinned to the job's workspace is the authority for the object key and type.
 * Re-running converges: the same bytes map to the same version and chunk keys.
 */
export async function runRagIngestJob(
  job: { workspaceId: string; payload: Record<string, unknown> },
  deps: RagIngestDeps
): Promise<IngestResult> {
  const fileId = job.payload['fileId'];
  if (typeof fileId !== 'string') {
    return { ok: false, code: 'INVALID_PAYLOAD', summary: 'Job payload is missing fileId', retryable: false };
  }
  if (!deps.embedding) {
    return { ok: false, code: 'EMBEDDING_PROVIDER_NOT_CONFIGURED', summary: 'embeddings are not configured', retryable: false };
  }

  const file = await deps.loadFile(job.workspaceId, fileId);
  if (!file) return { ok: true, detail: `no-op: file ${fileId} no longer exists` };

  const bytes = await deps.store.get(file.storageKey);
  if (!bytes) return { ok: false, code: 'OBJECT_MISSING', summary: `No stored bytes for file ${fileId}` };

  const prepared = await prepareSource(file.mimeType, bytes, deps.embedding, deps.reader);
  if (!prepared) {
    return { ok: false, code: 'EXTRACTION_UNSUPPORTED', summary: `cannot index ${file.mimeType}`, retryable: false };
  }

  const configId = await deps.ensureConfig(job.workspaceId, prepared.config);
  const version = await deps.upsertVersion({
    workspaceId: job.workspaceId,
    title: typeof job.payload['title'] === 'string' && job.payload['title'] ? job.payload['title'] : file.name,
    contentHash: contentHash(bytes),
    mimeType: file.mimeType,
    byteSize: bytes.byteLength,
    extractedText: prepared.extractedText,
    fileId,
  });

  const chunks = prepared.chunks.map((c) => ({ ...c, chunkKey: chunkKey(version.versionId, configId, c.chunkIndex) }));
  const vectors = await embedInBatches(deps.embedding, chunks.map((c) => c.content));
  const written = await deps.replaceChunks(job.workspaceId, version.versionId, configId, chunks, vectors);

  return {
    ok: true,
    detail: `indexed ${file.name}: ${written} chunks${prepared.flagged ? `, ${prepared.flagged} passages dropped by the number check` : ''}`,
  };
}
