/**
 * Embedding provider client (Slice 8)
 *
 * Embeddings come from the configured provider. There is no silent fake fallback:
 * if the provider is not configured the call fails closed, so a deployment cannot
 * quietly index meaningless vectors and later serve nonsense results.
 *
 * The deterministic local embedding lives in the pipeline module and is used by
 * tests only; it is never selected implicitly at runtime.
 */

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
}

// Stored as halfvec(512) (#386). qwen3-embedding returns 1024 dimensions and is
// trained for shorter prefixes, so longer vectors are cut and re-normalized.
export const DEFAULT_EMBEDDING_DIMENSIONS = 512;

/**
 * Loads embedding provider configuration from the environment.
 * Returns null when unconfigured so callers can report a clear, non-fatal state.
 */
export function loadEmbeddingConfigFromEnv(): EmbeddingConfig | null {
  // A local provider (Ollama, llama.cpp, TEI) needs no credential, so naming either
  // a key or a base URL counts as configured. Requiring a key would make the
  // keyless local case indistinguishable from "no provider at all".
  //
  // Deliberately separate from the chat/completions credentials: the configured
  // InferHub gateway exposes no embeddings endpoint, so borrowing its key would
  // silently fail at ingest time. Point these at any OpenAI-compatible embeddings
  // provider.
  const apiKey = process.env['OCTO_EMBEDDING_API_KEY'] ?? '';
  const baseUrl = process.env['OCTO_EMBEDDING_BASE_URL'];
  if (!apiKey && !baseUrl) return null;

  return {
    apiKey,
    // host.docker.internal reaches the host from inside the container; a host-side
    // run uses http://localhost:11434/v1 instead.
    baseUrl: baseUrl ?? 'http://host.docker.internal:11434/v1',
    model: process.env['OCTO_EMBEDDING_MODEL'] ?? 'qwen3-embedding:0.6b',
    dimensions: Number(process.env['OCTO_EMBEDDING_DIMENSIONS'] ?? DEFAULT_EMBEDDING_DIMENSIONS),
  };
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

/**
 * Requests embeddings for a batch of texts.
 * Throws on provider failure or a dimension mismatch rather than returning a
 * partially valid batch.
 */
export async function embedTexts(
  config: EmbeddingConfig,
  texts: string[]
): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    return { vectors: [], model: config.model, dimensions: config.dimensions };
  }

  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // A keyless local provider ignores auth; an empty bearer is just noise.
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input: texts }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`EMBEDDING_PROVIDER_ERROR: ${response.status} ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    model?: string;
  };

  const vectors = (payload.data ?? []).map((item) =>
    truncateEmbedding(item.embedding ?? [], config.dimensions)
  );
  if (vectors.length !== texts.length) {
    throw new Error(
      `EMBEDDING_COUNT_MISMATCH: requested ${texts.length} embeddings, received ${vectors.length}`
    );
  }

  for (const vector of vectors) {
    if (vector.length !== config.dimensions) {
      throw new Error(
        `EMBEDDING_DIMENSION_MISMATCH: expected ${config.dimensions}, received ${vector.length}`
      );
    }
  }

  return {
    vectors,
    model: payload.model ?? config.model,
    dimensions: config.dimensions,
  };
}

/**
 * Cuts a Matryoshka embedding to its first `dimensions` values and L2-normalizes
 * the result. A vector already at (or below) that length is returned unchanged,
 * so a short vector still fails the dimension check.
 */
export function truncateEmbedding(vector: number[], dimensions: number): number[] {
  if (vector.length <= dimensions) return vector;
  const head = vector.slice(0, dimensions);
  const norm = Math.sqrt(head.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? head.map((x) => x / norm) : head;
}
