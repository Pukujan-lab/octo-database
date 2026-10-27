-- Octo Schema: Slice 8 - Hybrid retrieval lexical normalization
--
-- The hybrid migration added a lexical arm over `to_tsvector('english', content)`,
-- but the parser treats an entire URL path as one token. Measured on production
-- (workspace 76d7577b, 882 chunks) with the query `ESM_nguha__legalbench_citation_prediction`:
--
--   document side: '/davidschulte/esm_nguha__legalbench_citation_prediction_open':4
--   query side:    'citat':4 'esm':1 'legalbench':3 'nguha':2 'predict':5
--
-- The document lexeme is a single opaque string, so none of the five query lexemes
-- intersect it and the lexical arm cannot find the chunk that literally contains the
-- identifier. That defeats the reason the lexical arm exists: the vector arm ranked
-- those same two chunks 62nd and 118th, so neither arm recovered them.
--
-- Fix: normalize non-alphanumeric runs to spaces before tokenizing, on both sides.
-- This splits URL paths, snake_case, kebab-case and dotted names into word tokens so
-- an identifier matches whether it appears standalone or embedded in a path. It is
-- applied identically to documents and queries, so the two sides stay symmetric --
-- which is the property the original design relied on and this migration restores.
--
-- The tsvector column is derived data, so it is dropped and re-added rather than
-- migrated in place; the ADD backfills every existing row. `content` is untouched.

ALTER TABLE octo.chunks DROP COLUMN IF EXISTS content_tsv;

ALTER TABLE octo.chunks
    ADD COLUMN content_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', regexp_replace(content, '[^A-Za-z0-9]+', ' ', 'g'))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_content_tsv ON octo.chunks USING GIN (content_tsv);

-- Recreated with the same signature; only the query-side tokenization changed, so
-- both arms still fuse exactly as before.
DROP FUNCTION IF EXISTS octo.match_chunks_hybrid(UUID, vector, TEXT, INT);
CREATE FUNCTION octo.match_chunks_hybrid(
    target_workspace UUID,
    query_embedding vector(1024),
    query_text TEXT,
    match_count INT DEFAULT 10
)
RETURNS TABLE (
    chunk_id UUID,
    document_version_id UUID,
    content TEXT,
    chunk_index INT,
    similarity FLOAT,
    lexical_score FLOAT,
    score FLOAT,
    model TEXT,
    model_version TEXT,
    chunker TEXT
) AS $$
    WITH vec_raw AS (
        SELECT c.id AS chunk_id, 1 - (e.embedding <=> query_embedding) AS similarity
        FROM octo.embeddings e
        JOIN octo.chunks c ON c.id = e.chunk_id
        WHERE e.workspace_id = target_workspace
        ORDER BY e.embedding <=> query_embedding
        LIMIT match_count * 4
    ),
    vec AS (
        SELECT chunk_id, max(similarity)::float AS similarity
        FROM vec_raw
        GROUP BY chunk_id
    ),
    vec_ranked AS (
        SELECT chunk_id, similarity,
               row_number() OVER (ORDER BY similarity DESC, chunk_id) AS rank
        FROM vec
    ),
    -- The query text is normalized exactly as `content_tsv` is, so a query written
    -- with underscores or slashes produces the same lexemes the document produced.
    query_lexemes AS (
        SELECT string_agg(quote_literal(lexeme), ' | ') AS tsq
        FROM unnest(
            to_tsvector(
                'english',
                regexp_replace(coalesce(query_text, ''), '[^A-Za-z0-9]+', ' ', 'g')
            )
        ) AS t(lexeme, positions, weights)
    ),
    query_tsq AS (
        SELECT to_tsquery('english', NULLIF(tsq, '')) AS tsq FROM query_lexemes
    ),
    lex_raw AS (
        SELECT c.id AS chunk_id, ts_rank(c.content_tsv, q.tsq)::float AS lexical_score
        FROM octo.chunks c
        CROSS JOIN query_tsq q
        WHERE c.workspace_id = target_workspace
          AND q.tsq IS NOT NULL
          AND c.content_tsv @@ q.tsq
        ORDER BY lexical_score DESC, c.id
        LIMIT match_count * 4
    ),
    lex_ranked AS (
        SELECT chunk_id, lexical_score,
               row_number() OVER (ORDER BY lexical_score DESC, chunk_id) AS rank
        FROM lex_raw
    ),
    fused AS (
        SELECT
            coalesce(v.chunk_id, l.chunk_id) AS chunk_id,
            v.similarity,
            l.lexical_score,
            (CASE WHEN v.rank IS NOT NULL THEN 1.0 / (60 + v.rank) ELSE 0 END
           + CASE WHEN l.rank IS NOT NULL THEN 1.0 / (60 + l.rank) ELSE 0 END)::float AS score
        FROM vec_ranked v
        FULL OUTER JOIN lex_ranked l ON l.chunk_id = v.chunk_id
    )
    SELECT
        c.id,
        c.document_version_id,
        c.content,
        c.chunk_index,
        f.similarity,
        f.lexical_score,
        f.score,
        cfg.model,
        cfg.model_version,
        cfg.chunker
    FROM fused f
    JOIN octo.chunks c ON c.id = f.chunk_id
    JOIN octo.embedding_configs cfg ON cfg.id = c.config_id
    ORDER BY f.score DESC, c.id
    LIMIT match_count;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION octo.match_chunks_hybrid(UUID, vector, TEXT, INT) TO authenticated;
