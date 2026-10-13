-- Octo Schema: Slice 6 - Jobs and activity
-- Durable, Postgres-backed background work with explicit state, retry accounting,
-- and idempotency so a worker restart cannot produce duplicate side effects.

CREATE TABLE IF NOT EXISTS octo.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'paused'))
        DEFAULT 'queued',
    -- A repeated enqueue with the same key must not create a second logical job.
    idempotency_key TEXT NOT NULL,
    attempt INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at TIMESTAMPTZ,
    lease_owner TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    error_code TEXT,
    error_summary TEXT,
    -- Set once when the job reaches a terminal state, so completion is provable.
    completed_at TIMESTAMPTZ,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT jobs_idempotency_unique UNIQUE (workspace_id, job_type, idempotency_key),
    CONSTRAINT jobs_attempts_valid CHECK (attempt >= 0 AND max_attempts >= 1)
);

CREATE INDEX IF NOT EXISTS idx_jobs_workspace_id ON octo.jobs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON octo.jobs(state, available_at)
    WHERE state = 'queued';

-- Human-readable projections of actions. Not a substitute for debug logs, and
-- never a place to store credentials or raw tokens.
CREATE TABLE IF NOT EXISTS octo.activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    job_id UUID REFERENCES octo.jobs(id) ON DELETE SET NULL,
    actor_principal_id UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_workspace_id ON octo.activity(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_job_id ON octo.activity(job_id);

ALTER TABLE octo.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.activity ENABLE ROW LEVEL SECURITY;

-- Any workspace member may observe operations; only the server (trusted role)
-- transitions job state, so there is no client-side claim/complete policy.
CREATE POLICY jobs_select_member ON octo.jobs
    FOR SELECT
    USING (octo.is_workspace_member(workspace_id) = true);

CREATE POLICY activity_select_member ON octo.activity
    FOR SELECT
    USING (octo.is_workspace_member(workspace_id) = true);

-- Enqueue/claim/complete run through the server, which authorizes the caller and
-- then acts as the trusted backend role.

-- Atomically claims the next runnable job for a worker.
-- SKIP LOCKED gives exactly one worker a given job, and the lease means a crashed
-- worker's job becomes claimable again after expiry instead of vanishing.
CREATE OR REPLACE FUNCTION octo.claim_job(
    target_worker TEXT,
    lease_seconds INT DEFAULT 60,
    target_workspace UUID DEFAULT NULL
)
RETURNS TABLE (
    job_id UUID,
    workspace_id UUID,
    job_type TEXT,
    attempt INT,
    payload JSONB
) AS $$
DECLARE
    claimed_id UUID;
BEGIN
    SELECT j.id INTO claimed_id
    FROM octo.jobs j
    WHERE (
            (j.state = 'queued' AND j.available_at <= now())
            OR (j.state = 'running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= now())
          )
      AND (target_workspace IS NULL OR j.workspace_id = target_workspace)
    ORDER BY j.available_at ASC, j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF claimed_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE octo.jobs j
    SET state = 'running',
        attempt = j.attempt + 1,
        lease_owner = target_worker,
        lease_expires_at = now() + make_interval(secs => lease_seconds),
        updated_at = now()
    WHERE j.id = claimed_id
    RETURNING j.id, j.workspace_id, j.job_type, j.attempt, j.payload;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DML only: TRUNCATE and REFERENCES are not subject to row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.activity TO authenticated;
