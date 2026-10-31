/**
 * Optional reranking for retrieval (issue #365, part 3).
 *
 * With `rerank: true` on a query, the hybrid search returns a wider candidate set
 * and a small cross-encoder (bge-reranker-v2-m3 served by llama.cpp `llama-server
 * --reranking`, behind llama-swap so it starts cold on demand) re-scores each
 * candidate against the query. Off by default; the response shape is unchanged
 * apart from `rerankScore` on each match.
 *
 * Env:
 *   OCTO_RERANK_URL     base URL of a `/v1/rerank` server, e.g. http://agents.tail7065c3.ts.net:6787/v1.
 *                       Several comma-separated URLs are tried in order (a GPU machine,
 *                       then a local one).
 *   OCTO_RERANK_MODEL   model name sent to the server (default bge-reranker)
 */

export interface RerankConfig {
  baseUrls: string[];
  model: string;
}

/** How many hybrid candidates the reranker sees for a final `limit`. */
export function rerankCandidateCount(limit: number): number {
  return Math.min(Math.max(limit * 3, 30), 100);
}

export function loadRerankConfigFromEnv(): RerankConfig | null {
  const baseUrls = (process.env['OCTO_RERANK_URL'] ?? '')
    .split(',')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (baseUrls.length === 0) return null;
  return { baseUrls, model: process.env['OCTO_RERANK_MODEL'] ?? 'bge-reranker' };
}

/**
 * Scores each document against the query. Returns one score per document, in the
 * documents' order, from the first server that answers; null when none does, so
 * the caller can keep the hybrid order instead of failing the query.
 */
export async function rerankScores(config: RerankConfig, query: string, documents: string[]): Promise<number[] | null> {
  if (documents.length === 0) return [];
  for (const baseUrl of config.baseUrls) {
    try {
      // llama-swap answers /models before the model is loaded, so a cold GPU
      // machine is picked over a warm fallback; an unreachable one fails fast.
      const probe = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
      if (!probe.ok) continue;
      const response = await fetch(`${baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, query, documents, top_n: documents.length }),
        // Covers a cold start (the model loads on the first request).
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { results?: Array<{ index: number; relevance_score: number }> };
      const scores = new Array<number>(documents.length).fill(Number.NEGATIVE_INFINITY);
      for (const result of body.results ?? []) {
        if (result.index >= 0 && result.index < documents.length) scores[result.index] = result.relevance_score;
      }
      return scores;
    } catch {
      // Unreachable or timed out: try the next one.
    }
  }
  return null;
}
