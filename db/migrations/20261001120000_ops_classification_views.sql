-- Octo Schema: Ops classification views (issue #140, slice O2)
--
-- Read-only projections over octo.ops_events (O1) and octo.jobs, so captured
-- failures become an analytics surface: what is failing, how often, and which
-- work is stuck. No new table, no scheduler, no materialized state -- views only.
--
-- Each view is declared `security_invoker = true` (Postgres 15+): the caller's own
-- RLS context applies, so the member/platform-owner policies and the slice-14
-- tenant fence on the underlying tables are NOT bypassed by reading through a
-- view. A plain (definer) view owned by the migration role would silently read
-- every workspace's rows.

-- Failures grouped by error code: how often each code fires, and when it last did.
-- Kept per-workspace so a member's read is scoped by the underlying policies.
CREATE OR REPLACE VIEW octo.ops_failure_counts
WITH (security_invoker = true) AS
SELECT
    workspace_id,
    error_code,
    source,
    severity,
    count(*)        AS event_count,
    min(created_at) AS first_seen,
    max(created_at) AS last_seen
FROM octo.ops_events
GROUP BY workspace_id, error_code, source, severity;

-- Failure counts by job type and day, for spotting a job class that regressed.
CREATE OR REPLACE VIEW octo.ops_failures_by_job_type_day
WITH (security_invoker = true) AS
SELECT
    workspace_id,
    job_type,
    date_trunc('day', created_at) AS day,
    error_code,
    count(*) AS event_count
FROM octo.ops_events
WHERE job_type IS NOT NULL
GROUP BY workspace_id, job_type, date_trunc('day', created_at), error_code;

-- Work that needs attention: terminal failures, or a running job whose lease
-- expired -- the same condition claim_job treats as reclaimable, i.e. a dead
-- worker. Queued and lease-live running jobs are healthy and excluded.
CREATE OR REPLACE VIEW octo.ops_unhealthy_jobs
WITH (security_invoker = true) AS
SELECT
    j.id              AS job_id,
    j.workspace_id,
    j.job_type,
    j.state,
    j.attempt,
    j.max_attempts,
    j.lease_expires_at,
    j.error_code,
    j.error_summary,
    j.updated_at
FROM octo.jobs j
WHERE j.state = 'failed'
   OR (j.state = 'running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= now());

-- The runtime roles inherit `authenticated` (slice 14), so this is what makes the
-- views readable on the request path -- still subject to the RLS above.
GRANT SELECT ON octo.ops_failure_counts, octo.ops_failures_by_job_type_day, octo.ops_unhealthy_jobs TO authenticated;
