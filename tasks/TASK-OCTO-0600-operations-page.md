# OCTO-0600 Operations page, jobs, and activity

<!-- continuity:task {"acceptance":["Postgres-backed job table with an explicit monotonic state machine","duplicate idempotency key returns the original job instead of creating a second","a worker that dies mid-job leaves a lease that expires, and the job converges on restart","no duplicate side effect when a worker crashes after the side effect but before completion","retry exhaustion terminates the job with an inspectable error summary","operations page shows job state, attempt count, error summary, and recent activity","unauthorized workspace job access is denied"],"depends_on":["OCTO-0300","OCTO-0400"],"goal":"Give background work durable job identity, retry semantics, and an operations page","id":"OCTO-0600","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/8","next_action":"Merged in PR #31 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P1","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Make thumbnails and later archive/agent jobs observable and retryable without ad-hoc process logs."} -->

- Status: completed
- Priority: P1
- Branch: `task/OCTO-0600-operations-page`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/8

## Goal

Create a minimal operational model for background work so thumbnails, archive/restore, and later agent/data jobs are observable and retryable, with idempotency that survives worker interruption.

## Prepared on this branch

- Migration `supabase/migrations/20261001030000_slice6_jobs_and_activity.sql` defining `octo.jobs`,
  `octo.activity`, member-only RLS, and a lease-based `octo.claim_job` using `FOR UPDATE SKIP LOCKED`.
- Job service `src/jobs/job-service.ts` (state machine, idempotent enqueue, retry with backoff, activity).
- Worker `src/jobs/worker.ts` (lease claim, handler dispatch, convergence on crash).
- Server routes: `POST/GET /api/jobs`, `POST /api/jobs/:id/retry`, `POST /api/jobs/run`,
  `GET /api/activity`.
- Operations page `src/ui/OperationsPage.tsx`, wired into the dashboard.
- Tests: `tests/unit/job-state.test.ts`, `tests/integration/job-worker.test.ts`,
  `tests/e2e/operations.spec.ts`.

## Design notes

- States are explicit and monotonic where possible: `queued → running → completed`, with retryable
  failure returning through a controlled `running → queued` transition. Terminal states never move.
- Idempotency is enforced by a unique `(workspace_id, job_type, idempotency_key)` constraint, so a
  repeated enqueue returns the original row rather than a second logical job.
- `claim_job` uses `FOR UPDATE SKIP LOCKED`, so exactly one worker receives a given job.
- Recovery is lease-based: a crashed worker stops renewing its lease and the job becomes claimable
  again, rather than being lost or silently duplicated.
- Side effects are keyed by job identity, so re-running after a crash reuses the existing derivative.

## Checkpoint log

### 2026-10-01 06:00:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["supabase/migrations/20261001030000_slice6_jobs_and_activity.sql","src/jobs/job-service.ts","src/jobs/worker.ts","src/ui/OperationsPage.tsx","src/server/index.ts","tests/e2e/operations.spec.ts"],"completed":["Durable job queue with lease-based recovery, retry accounting, and an operations page"],"decisions":["Enforce idempotency with a unique key constraint rather than application-side dedupe","Use FOR UPDATE SKIP LOCKED with a lease so a crashed worker's job is reclaimed","Treat malformed payloads as permanent failures so they cannot retry forever"],"evidence":["Live run: duplicate idempotency key returned created=false and the workspace still had exactly 1 job","Live run: worker pass completed the job (attempt 1) and activity recorded enqueue plus transition","Live crash drill: job claimed by a worker that never returned stayed running with a lease; after lease expiry a new pass reclaimed it and completed it (attempt 2) with exactly 1 derivative on disk","Live run: unauthorized workspace job access returned 403, anonymous returned 401","51 unit/integration tests and 2 Playwright operations tests pass"],"next_action":"Merge PR after green gates, then continue with the next accepted slice","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0600","timestamp":"2026-10-01T06:00:00Z"} -->

Completed:
- Durable job queue with lease-based recovery, retry accounting, and an operations page

Evidence:
- Live run: duplicate idempotency key returned created=false and the workspace still had exactly 1 job
- Live run: worker pass completed the job (attempt 1) and activity recorded enqueue plus transition
- Live crash drill: the job was claimed by a worker that never returned and stayed running with a lease; after lease expiry a new pass reclaimed it and completed it (attempt 2) with exactly 1 derivative on disk
- Live run: unauthorized workspace job access returned 403, anonymous returned 401
- 51 unit/integration tests and 2 Playwright operations tests pass

Decisions:
- Enforce idempotency with a unique key constraint rather than application-side dedupe
- Use FOR UPDATE SKIP LOCKED with a lease so a crashed worker's job is reclaimed
- Treat malformed payloads as permanent failures so they cannot retry forever

Changed:
- supabase/migrations/20261001030000_slice6_jobs_and_activity.sql
- src/jobs/job-service.ts
- src/jobs/worker.ts
- src/ui/OperationsPage.tsx
- src/server/index.ts
- tests/e2e/operations.spec.ts

Blocked/uncertain:
- none

Next:
- Merge PR after green gates, then continue with the next accepted slice

### 2026-10-01 05:12:47 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["tasks/TASK-OCTO-0600-operations-page.md","checkpoints/CURRENT.md"],"completed":["Slice 6 operations page closed out after merge"],"decisions":["Record the merge and advance the current projection rather than leaving Slice 6 marked in review"],"evidence":["PR #31 merged into main as 4a553d6 with green gates (run 36818517356)"],"next_action":"Pick the next accepted slice from the open issues and open its task file.","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0600","timestamp":"2026-10-01T05:12:47Z"} -->

Completed:
- Slice 6 operations page closed out after merge

Evidence:
- PR #31 merged into main as 4a553d6 with green gates (run 36818517356)

Decisions:
- Record the merge and advance the current projection rather than leaving Slice 6 marked in review

Changed:
- tasks/TASK-OCTO-0600-operations-page.md
- checkpoints/CURRENT.md

Blocked/uncertain:
- none

Next:
- Pick the next accepted slice from the open issues and open its task file.
