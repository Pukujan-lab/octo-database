/**
 * Retrieval pipeline (Slice 8)
 *
 * Ownership:
 *   * canonical  -- document/version metadata, chunk provenance, embedding config
 *   * durable    -- the original object in R2/Drive (octo.files), never touched
 *   * derived    -- chunks and vectors, rebuildable from the original
 *
 * Two invariants drive the design:
 *   1. Deterministic identity: the same bytes under the same config produce the same
 *      chunk keys, so re-running the pipeline targets existing rows instead of
 *      appending duplicates.
 *   2. Rebuild safety: deleting chunks/embeddings must not destroy the source or
 *      version record, and re-embedding under a new config must not erase the
 *      historical config identity.
 */

import { createHash } from 'crypto';

export interface ChunkConfig {
  model: string;
  modelVersion: string;
  dimensions: number;
  chunker: string;
  chunkSize: number;
  chunkOverlap: number;
}

export interface Chunk {
  chunkIndex: number;
  chunkKey: string;
  content: string;
  startOffset: number;
  endOffset: number;
  tokenEstimate: number;
}

/** Rough token estimate: ~4 characters per token for English prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Content hash identifying an immutable version of a source. */
export function contentHash(bytes: Buffer | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes;
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/**
 * Deterministic chunk key. Derived from the version, config, and chunk index, so
 * the same input always maps to the same key and re-ingestion is idempotent.
 */
export function chunkKey(
  documentVersionId: string,
  configId: string,
  chunkIndex: number
): string {
  return createHash('sha256')
    .update(`${documentVersionId}:${configId}:${chunkIndex}`)
    .digest('hex')
    .slice(0, 32);
}

/** Configuration identity string used to detect a changed embedding setup. */
export function configFingerprint(config: ChunkConfig): string {
  return [
    config.model,
    config.modelVersion,
    `d${config.dimensions}`,
    config.chunker,
    `s${config.chunkSize}`,
    `o${config.chunkOverlap}`,
  ].join('|');
}

/**
 * Splits text into overlapping chunks, preferring paragraph and sentence boundaries
 * so a chunk stays readable on its own.
 */
export function chunkText(text: string, config: ChunkConfig): Chunk[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.trim().length === 0) return [];

  const size = config.chunkSize;
  const overlap = config.chunkOverlap;

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);

    // Prefer to end on a paragraph or sentence boundary when one is nearby.
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
      if (boundary > size * 0.5) {
        end = start + boundary + 1;
      }
    }

    const content = normalized.slice(start, end);
    if (content.trim().length > 0) {
      chunks.push({
        chunkIndex: index,
        chunkKey: '',
        content,
        startOffset: start,
        endOffset: end,
        tokenEstimate: estimateTokens(content),
      });
      index += 1;
    }

    if (end >= normalized.length) break;
    // Start the next chunk from where this one actually ended (minus the overlap),
    // not a fixed step: an early boundary end would otherwise leave text in no chunk.
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

/**
 * Extracts plain text from a source payload.
 * Text-like sources pass through; unsupported binary returns null so the caller can
 * record an extraction failure rather than silently indexing garbage.
 */
export function extractText(mimeType: string, bytes: Buffer): string | null {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';

  if (normalized.startsWith('text/') || normalized === 'application/json') {
    return bytes.toString('utf-8');
  }
  if (normalized === 'application/pdf') {
    // A PDF text layer needs a real parser; refuse rather than index raw bytes.
    return null;
  }
  return null;
}

/** Cosine similarity for in-process comparisons (SQL uses pgvector's operator). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Deterministic pseudo-embedding for tests and offline runs. */
export function deterministicEmbedding(text: string, dimensions: number): number[] {
  const vector: number[] = new Array(dimensions).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    for (let i = 0; i < dimensions; i += 1) {
      // Spread each token across the vector deterministically.
      vector[i] += (digest[i % digest.length]! - 128) / 128;
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}
