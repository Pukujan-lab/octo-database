-- Octo Schema: Slice 8 - Document filter on hybrid retrieval, and chunk pages
--
-- Issue #364: a caller could only search the whole workspace, so asking about one
-- document meant fetching extra matches and dropping the rest client-side, which
-- loses matches that fell below the limit. The filter is now applied inside both
-- arms, before each arm's LIMIT.
--
-- The filtered vector arm orders by `(embedding <=> query) + 0` on purpose: that
-- expression cannot use the HNSW index, so the scan is exact over the filtered
-- rows. An approximate index scan stops after ef_search candidates and would drop
-- matches the filter then removes. The unfiltered arm keeps the index.
--
-- Issue #365: chunks cut from a PDF record the page they came from (NULL for text).

ALTER TABLE octo.chunks ADD COLUMN IF NOT EXISTS page INT;

DROP FUNCTION IF EXISTS octo.match_chunks_hybrid(UUID, vector, TEXT, INT);
CREATE FUNCTION octo.match_chunks_hybrid(
    target_workspace UUID,
    query_embedding vector(1024),
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter_document_ids UUID[] DEFAULT NULL,
    filter_title_prefix TEXT DEFAULT NULL,
    filter_latest_only BOOLEAN DEFAULT false
)
RETURNS TABLE (
    chunk_id UUID,
    document_version_id UUID,
    document_id UUID,
    title TEXT,
    version_number INT,
    page INT,
    content TEXT,
    chunk_index INT,
    similarity FLOAT,
    lexical_score FLOAT,
    score FLOAT,
    model TEXT,
    model_version TEXT,
    chunker TEXT
) AS $$
    WITH params AS (
        SELECT (filter_document_ids IS NOT NULL
                OR filter_title_prefix IS NOT NULL
                OR coalesce(filter_latest_only, false)) AS filtered
    ),
    allowed AS (
        SELECT c.id AS chunk_id
        FROM octo.chunks c
        JOIN octo.document_versions v ON v.id = c.document_version_id
        JOIN octo.documents d ON d.id = v.document_id
        WHERE c.workspace_id = target_workspace
          AND (filter_document_ids IS NULL OR d.id = ANY(filter_document_ids))
          AND (filter_title_prefix IS NULL
               OR left(d.title, length(filter_title_prefix)) = filter_title_prefix)
          AND (NOT coalesce(filter_latest_only, false)
               OR v.version_number = (SELECT max(v2.version_number)
                                      FROM octo.document_versions v2
                                      WHERE v2.document_id = v.document_id))
    ),
    vec_raw AS (
        (SELECT c.id AS chunk_id, 1 - (e.embedding <=> query_embedding) AS similarity
         FROM octo.embeddings e
         JOIN octo.chunks c ON c.id = e.chunk_id
         WHERE e.workspace_id = target_workspace
           AND NOT (SELECT filtered FROM params)
         ORDER BY e.embedding <=> query_embedding
         LIMIT match_count * 4)
        UNION ALL
        (SELECT c.id AS chunk_id, 1 - (e.embedding <=> query_embedding) AS similarity
         FROM octo.embeddings e
         JOIN octo.chunks c ON c.id = e.chunk_id
         JOIN allowed a ON a.chunk_id = c.id
         WHERE e.workspace_id = target_workspace
           AND (SELECT filtered FROM params)
         ORDER BY (e.embedding <=> query_embedding) + 0
         LIMIT match_count * 4)
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
          AND (NOT (SELECT filtered FROM params)
               OR c.id IN (SELECT chunk_id FROM allowed))
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
        dv.document_id,
        d.title,
        dv.version_number,
        c.page,
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
    JOIN octo.document_versions dv ON dv.id = c.document_version_id
    JOIN octo.documents d ON d.id = dv.document_id
    JOIN octo.embedding_configs cfg ON cfg.id = c.config_id
    ORDER BY f.score DESC, c.id
    LIMIT match_count;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION octo.match_chunks_hybrid(UUID, vector, TEXT, INT, UUID[], TEXT, BOOLEAN)
    TO authenticated;
