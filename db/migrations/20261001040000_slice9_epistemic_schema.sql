-- Octo Schema: Slice 9 - Epistemic workspace (bitemporal claims, beliefs, evidence)
--
-- Two independent time axes:
--   * valid time   (valid_from/valid_to)   -- when the claim is true in the world
--   * recorded time (recorded_at/superseded_at) -- when Octo came to believe it
--
-- Nothing is overwritten. A correction closes the previous record's recorded-time
-- interval and inserts a new row, so "what did perspective P believe at T2" and
-- "what do we now consider valid at T2" are different questions with different
-- answers, both answerable from history.
--
-- Belief is NOT a mutable column on claim: it lives in octo.beliefs, keyed by
-- perspective, so two perspectives can hold different beliefs about one claim.

CREATE TABLE IF NOT EXISTS octo.epistemic_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'entity',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT epistemic_entities_unique UNIQUE (workspace_id, name, entity_type)
);

-- Immutable evidence references. Points at a logical file/version; never stores
-- bytes or provider credentials.
CREATE TABLE IF NOT EXISTS octo.evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    source_file_id UUID REFERENCES octo.files(id) ON DELETE SET NULL,
    locator TEXT,
    quote TEXT,
    content_hash TEXT,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON octo.evidence(workspace_id);

-- Claims with bitemporal intervals.
CREATE TABLE IF NOT EXISTS octo.claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    subject_entity_id UUID REFERENCES octo.epistemic_entities(id) ON DELETE SET NULL,
    statement TEXT NOT NULL,
    -- Valid time: when the statement holds in the world.
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    -- Recorded time: when Octo recorded this assertion.
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When this record stopped being the current assertion (closed on correction).
    superseded_at TIMESTAMPTZ,
    -- Provenance to the run/source that produced it.
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    CONSTRAINT claims_valid_interval CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS idx_claims_workspace ON octo.claims(workspace_id);
CREATE INDEX IF NOT EXISTS idx_claims_recorded ON octo.claims(workspace_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_claims_valid ON octo.claims(workspace_id, valid_from, valid_to);

-- Perspectives whose beliefs are tracked independently.
CREATE TABLE IF NOT EXISTS octo.perspectives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT perspectives_unique UNIQUE (workspace_id, name)
);

-- A belief is one perspective's stance on one claim, itself bitemporal.
CREATE TABLE IF NOT EXISTS octo.beliefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    perspective_id UUID NOT NULL REFERENCES octo.perspectives(id) ON DELETE CASCADE,
    claim_id UUID NOT NULL REFERENCES octo.claims(id) ON DELETE CASCADE,
    stance TEXT NOT NULL CHECK (stance IN ('believes', 'disbelieves', 'uncertain')),
    confidence NUMERIC(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT beliefs_valid_interval CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS idx_beliefs_lookup ON octo.beliefs(workspace_id, perspective_id, claim_id);

-- Claim-to-claim relations, also bitemporal so a contradiction can itself be revised.
CREATE TABLE IF NOT EXISTS octo.claim_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    from_claim_id UUID NOT NULL REFERENCES octo.claims(id) ON DELETE CASCADE,
    to_claim_id UUID NOT NULL REFERENCES octo.claims(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (
        relation IN ('SUPPORTS', 'CONTRADICTS', 'SUPERSEDES', 'QUALIFIES', 'DERIVED_FROM', 'DUPLICATES', 'REFINES')
    ),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at TIMESTAMPTZ,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    CONSTRAINT claim_relations_no_self CHECK (from_claim_id <> to_claim_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_relations_from ON octo.claim_relations(from_claim_id);

-- Which evidence supports or contradicts which claim.
CREATE TABLE IF NOT EXISTS octo.claim_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    claim_id UUID NOT NULL REFERENCES octo.claims(id) ON DELETE CASCADE,
    evidence_id UUID NOT NULL REFERENCES octo.evidence(id) ON DELETE CASCADE,
    stance TEXT NOT NULL CHECK (stance IN ('supports', 'contradicts', 'qualifies')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT claim_evidence_unique UNIQUE (claim_id, evidence_id, stance)
);

ALTER TABLE octo.epistemic_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.perspectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.beliefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.claim_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.claim_evidence ENABLE ROW LEVEL SECURITY;

-- Workspace members may read the epistemic ledger.
CREATE POLICY epistemic_entities_select_member ON octo.epistemic_entities
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY evidence_select_member ON octo.evidence
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY claims_select_member ON octo.claims
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY perspectives_select_member ON octo.perspectives
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY beliefs_select_member ON octo.beliefs
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY claim_relations_select_member ON octo.claim_relations
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY claim_evidence_select_member ON octo.claim_evidence
    FOR SELECT USING (octo.is_workspace_member(workspace_id));

-- Writers must be operator or above; readers may be any member.
CREATE POLICY claims_insert_operator ON octo.claims
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY beliefs_insert_operator ON octo.beliefs
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY evidence_insert_operator ON octo.evidence
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY claim_relations_insert_operator ON octo.claim_relations
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY claim_evidence_insert_operator ON octo.claim_evidence
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY epistemic_entities_insert_operator ON octo.epistemic_entities
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY perspectives_insert_operator ON octo.perspectives
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

-- Corrections close intervals rather than deleting rows.
CREATE POLICY claims_update_operator ON octo.claims
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY beliefs_update_operator ON octo.beliefs
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

-- What perspective P believed about a claim as of a recorded instant, and whether
-- it was considered valid at a world instant. Both axes are applied independently.
CREATE OR REPLACE FUNCTION octo.belief_as_of(
    target_workspace UUID,
    target_perspective UUID,
    target_claim UUID,
    as_of_recorded TIMESTAMPTZ,
    as_of_valid TIMESTAMPTZ
)
RETURNS TABLE (stance TEXT, confidence NUMERIC, belief_id UUID) AS $$
    SELECT b.stance, b.confidence, b.id
    FROM octo.beliefs b
    WHERE b.workspace_id = target_workspace
      AND b.perspective_id = target_perspective
      AND b.claim_id = target_claim
      -- Recorded time: what had been recorded by that instant.
      AND b.recorded_at <= as_of_recorded
      AND (b.superseded_at IS NULL OR b.superseded_at > as_of_recorded)
      -- Valid time: what was true in the world at that instant.
      AND b.valid_from <= as_of_valid
      AND (b.valid_to IS NULL OR b.valid_to > as_of_valid)
    ORDER BY b.recorded_at DESC
    LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Claims recorded as current as of an instant, optionally as of a world instant.
CREATE OR REPLACE FUNCTION octo.claims_as_of(
    target_workspace UUID,
    as_of_recorded TIMESTAMPTZ,
    as_of_valid TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (claim_id UUID, statement TEXT, valid_from TIMESTAMPTZ, valid_to TIMESTAMPTZ) AS $$
    SELECT c.id, c.statement, c.valid_from, c.valid_to
    FROM octo.claims c
    WHERE c.workspace_id = target_workspace
      AND c.recorded_at <= as_of_recorded
      AND (c.superseded_at IS NULL OR c.superseded_at > as_of_recorded)
      AND (
          as_of_valid IS NULL
          OR (c.valid_from <= as_of_valid AND (c.valid_to IS NULL OR c.valid_to > as_of_valid))
      )
    ORDER BY c.recorded_at DESC;
$$ LANGUAGE sql STABLE;

-- DML only: TRUNCATE and REFERENCES are not subject to row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.epistemic_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.evidence TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.claims TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.perspectives TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.beliefs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.claim_relations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.claim_evidence TO authenticated;
GRANT EXECUTE ON FUNCTION octo.belief_as_of(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION octo.claims_as_of(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
