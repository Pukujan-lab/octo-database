/**
 * Unit Tests: Retrieval pipeline (Slice 8)
 */

import { describe, expect, it } from 'vitest';
import { truncateEmbedding } from '../../src/rag/embeddings';
import {
  chunkKey,
  chunkText,
  configFingerprint,
  contentHash,
  cosineSimilarity,
  deterministicEmbedding,
  estimateTokens,
  extractText,
  ChunkConfig,
} from '../../src/rag/pipeline';

const CONFIG: ChunkConfig = {
  model: 'text-embedding-3-small',
  modelVersion: '1',
  dimensions: 1024,
  chunker: 'paragraph-aware',
  chunkSize: 200,
  chunkOverlap: 40,
};

describe('Deterministic identity', () => {
  it('hashes content stably and detects change', () => {
    const a = contentHash('hello world');
    expect(a).toBe(contentHash('hello world'));
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(contentHash('hello worlds')).not.toBe(a);
  });

  it('produces the same chunk key for the same inputs', () => {
    const key = chunkKey('version-1', 'config-1', 0);
    expect(key).toBe(chunkKey('version-1', 'config-1', 0));
    expect(key).not.toBe(chunkKey('version-1', 'config-1', 1));
    expect(key).not.toBe(chunkKey('version-2', 'config-1', 0));
    expect(key).not.toBe(chunkKey('version-1', 'config-2', 0));
  });

  it('changes the config fingerprint when any dimension of identity changes', () => {
    const base = configFingerprint(CONFIG);
    expect(configFingerprint({ ...CONFIG })).toBe(base);
    expect(configFingerprint({ ...CONFIG, model: 'other' })).not.toBe(base);
    expect(configFingerprint({ ...CONFIG, modelVersion: '2' })).not.toBe(base);
    expect(configFingerprint({ ...CONFIG, chunkSize: 300 })).not.toBe(base);
    expect(configFingerprint({ ...CONFIG, chunkOverlap: 0 })).not.toBe(base);
  });
});

describe('Chunking', () => {
  it('returns no chunks for empty or whitespace input', () => {
    expect(chunkText('', CONFIG)).toEqual([]);
    expect(chunkText('   \n\n  ', CONFIG)).toEqual([]);
  });

  it('covers the source and keeps offsets addressable', () => {
    const text = 'Alpha sentence. '.repeat(60);
    const chunks = chunkText(text, CONFIG);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startOffset).toBe(0);

    // Every chunk's offsets must slice back to its own content exactly.
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.content);
    }

    // The final chunk reaches the end of the source.
    expect(chunks[chunks.length - 1]!.endOffset).toBe(text.length);
  });

  it('leaves no text outside every chunk when a chunk ends early on a break (#357)', () => {
    // A paragraph or sentence break early in each window ends the chunk early;
    // the next chunk must start from that end, not a fixed step later.
    const inputs = [
      ('x'.repeat(450) + '\n\n').repeat(12),
      ('Short sentence here. ' + 'y'.repeat(430) + '. ').repeat(10),
      Array.from({ length: 40 }, (_, i) => `## Heading ${i}\n\n${'z'.repeat(100 + ((i * 97) % 600))}`).join('\n\n'),
    ];
    for (const text of inputs) {
      const covered = new Array(text.length).fill(false);
      for (const chunk of chunkText(text, CONFIG)) {
        for (let i = chunk.startOffset; i < chunk.endOffset; i += 1) covered[i] = true;
      }
      expect(covered.indexOf(false)).toBe(-1);
    }
  });

  it('produces stable indices and token estimates', () => {
    const chunks = chunkText('word '.repeat(200), CONFIG);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBe(estimateTokens(chunk.content));
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
    }
  });

  it('is deterministic for the same input and config', () => {
    const text = 'Deterministic chunking matters. '.repeat(30);
    const first = chunkText(text, CONFIG);
    const second = chunkText(text, CONFIG);
    expect(second.map((c) => c.content)).toEqual(first.map((c) => c.content));
    expect(second.map((c) => c.endOffset)).toEqual(first.map((c) => c.endOffset));
  });
});

describe('Extraction', () => {
  it('extracts text-like sources', () => {
    expect(extractText('text/plain', Buffer.from('hello'))).toBe('hello');
    expect(extractText('application/json', Buffer.from('{"a":1}'))).toBe('{"a":1}');
    expect(extractText('text/markdown; charset=utf-8', Buffer.from('# Title'))).toBe('# Title');
  });

  it('refuses formats it cannot faithfully extract rather than indexing garbage', () => {
    // A PDF text layer needs a real parser.
    expect(extractText('application/pdf', Buffer.from('%PDF-1.4'))).toBeNull();
    expect(extractText('image/png', Buffer.from([0x89, 0x50]))).toBeNull();
    expect(extractText('video/mp4', Buffer.from([0, 0, 0, 1]))).toBeNull();
  });
});

describe('Embeddings', () => {
  it('produces unit-length vectors of the configured size', () => {
    const vector = deterministicEmbedding('retrieval augmented generation', 1024);
    expect(vector.length).toBe(1024);
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic and content-sensitive', () => {
    const a = deterministicEmbedding('policy emissions', 64);
    const b = deterministicEmbedding('policy emissions', 64);
    const c = deterministicEmbedding('unrelated content', 64);
    expect(a).toEqual(b);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, c)).toBeLessThan(1);
  });

  it('scores identical vectors as maximally similar and orthogonal ones as zero', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('cuts a longer embedding to the stored width and re-normalizes it', () => {
    const cut = truncateEmbedding([3, 4, 12], 2);
    expect(cut).toHaveLength(2);
    expect(cut[0]).toBeCloseTo(0.6);
    expect(cut[1]).toBeCloseTo(0.8);
    expect(truncateEmbedding([1, 2], 4)).toEqual([1, 2]);
  });
});
