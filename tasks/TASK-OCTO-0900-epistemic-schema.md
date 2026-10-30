# OCTO-0900 Epistemic workspace with bitemporal claims, beliefs, and evidence

<!-- continuity:task {"acceptance":["PostgreSQL canonical epistemic schema for entities, claims, perspectives, beliefs, evidence, and relations","two independent time axes: valid time and recorded time","a claim recorded at T1, qualified at T2, and superseded at T3 retains its full history","a query answers what a perspective believed at an instant, applying both time axes","two perspectives can hold different belief states for the same claim","deleting derived beliefs does not destroy claim, evidence, or provenance records","cross-workspace epistemic rows are never returned to another workspace"],"depends_on":["OCTO-0200"],"goal":"Represent changing knowledge without overwriting history, with PostgreSQL as the canonical epistemic ledger","id":"OCTO-0900","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/11","next_action":"Merged in PR #34 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P2","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Let projects distinguish what was believed when from what is now considered true then."} -->

- Status: completed
- Priority: P2
- Branch: `task/OCTO-0900-epistemic-schema`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/11

## Goal

Add an optional epistemic schema for claims, beliefs, evidence, relations, provenance, and bitemporal
history, so a project can answer both "what did perspective P believe at T2?" and "with current
knowledge, what do we now consider valid at T2?" without overwriting anything.

## Prepared on this branch

- Migration `supabase/migrations/20261001040000_slice9_epistemic_schema.sql` defining
  `octo.epistemic_entities`, `octo.claims`, `octo.perspectives`, `octo.beliefs`,
  `octo.evidence`, `octo.claim_relations`, `octo.claim_evidence`, member-read RLS with
  operator-or-above writes, and the `octo.belief_as_of` / `octo.claims_as_of` query functions.
- Tests: `tests/test_slice9_schema.py`.

## Design notes

- **Two independent time axes.** `valid_from`/`valid_to` describe when a statement holds in the
  world; `recorded_at`/`superseded_at` describe when Octo came to hold it. Corrections close the
  previous record's recorded interval and insert a new row, so nothing is overwritten.
- **Belief is not a column on claim.** It lives in `octo.beliefs`, keyed by perspective, so two
  perspectives can hold different stances on the same claim.
- **Evidence is an immutable reference** to a file/version plus a locator, quote, and hash. No
  bytes, no provider credentials, no mutable ownership of the original.
- **Optional by construction.** The schema is additive and separate from gallery/files, so ordinary
  workspaces are unaffected.

## Checkpoint log

### 2026-10-01 08:00:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["supabase/migrations/20261001040000_slice9_epistemic_schema.sql","tests/test_slice9_schema.py"],"completed":["Bitemporal epistemic schema with perspective-scoped beliefs, evidence provenance, and as-of query functions"],"decisions":["Model belief as its own perspective-keyed table rather than a mutable claim column","Close recorded-time intervals on correction instead of updating rows in place","Expose as-of queries as SQL functions so both time axes are applied together"],"evidence":["Live: claim A recorded at T1, qualified at T2, superseded at T3; all three claim rows still present","Live: belief_as_of for Analyst A returned believes(0.900) at recorded 2026-06-01 and disbelieves(0.850) at recorded 2027-01-01 for the same valid instant","Live: at identical instants Analyst A returned disbelieves(0.850) while Analyst B returned uncertain(0.400) for the same claim","Live: claims_as_of listed 2 claims at recorded 2026-06-01 and a different 2 at 2027-01-01","Live: deleting all beliefs left 3 claims and 1 evidence row intact, and provenance (run-3) survived","Live: an outsider principal saw 0 claims and 0 evidence rows from another workspace","41 Python tests pass"],"next_action":"Merge PR after green gates, then continue with the next accepted slice","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0900","timestamp":"2026-10-01T08:00:00Z"} -->

Completed:
- Bitemporal epistemic schema with perspective-scoped beliefs, evidence provenance, and as-of query functions

Evidence:
- Live: claim A was recorded at T1, qualified at T2, and superseded at T3; all three claim rows are still present
- Live: belief_as_of for Analyst A returned believes(0.900) at recorded 2026-06-01 and disbelieves(0.850) at recorded 2027-01-01 for the same valid instant
- Live: at identical instants Analyst A returned disbelieves(0.850) while Analyst B returned uncertain(0.400) for the same claim
- Live: claims_as_of listed 2 claims at recorded 2026-06-01 and a different 2 at 2027-01-01
- Live: deleting all beliefs left 3 claims and 1 evidence row intact, and provenance (run-3) survived
- Live: an outsider principal saw 0 claims and 0 evidence rows from another workspace
- 41 Python tests pass

Decisions:
- Model belief as its own perspective-keyed table rather than a mutable claim column
- Close recorded-time intervals on correction instead of updating rows in place
- Expose as-of queries as SQL functions so both time axes are applied together

Changed:
- supabase/migrations/20261001040000_slice9_epistemic_schema.sql
- tests/test_slice9_schema.py

Blocked/uncertain:
- Issue #11 lists #10 (Slice 8 retrieval) as a dependency. This slice delivers the schema and
  bitemporal query layer, which is self-contained and independently verified; the retrieval
  pipeline that would populate it remains Slice 8 work.

Next:
- Merge PR after green gates, then continue with the next accepted slice
