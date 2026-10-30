# OCTO-0400 Scoped gallery/folder share links

<!-- continuity:task {"acceptance":["owner creates a read-only album share returning a high-entropy token once","logged-out recipient views only the shared album and nothing else","sibling resources, workspace routes, and admin surfaces are unreachable with the token","only the token hash is stored; the raw token never appears in storage, logs, or audit output","revocation causes subsequent authorization to fail immediately","expiry boundary is enforced at the configured instant","upload permission is off by default and must be requested explicitly"],"depends_on":["OCTO-0300"],"goal":"Deliver scoped read-only share links with revocation and expiry for one gallery resource","id":"OCTO-0400","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/6","next_action":"Merged in PR #29 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P1","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Let an owner share exactly one album without granting access to the workspace or admin console."} -->

- Status: completed
- Priority: P1
- Branch: `task/OCTO-0400-scoped-share-links`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/6

## Goal

Allow an owner to share exactly one album through a scoped link without granting access to the admin console or the rest of the workspace. Read-only is the v1 default; upload sharing must be requested explicitly.

## Prepared on this branch

- Migration `supabase/migrations/20261001020000_slice4_scoped_shares.sql` defining `octo.shares`
  with owner/admin RLS, a token-hash-only record, and a `SECURITY DEFINER` `octo.resolve_share`.
- Share service `src/media/share-service.ts` (token hashing, constant-time comparison, activity
  evaluation, audit redaction).
- Share-scoped media signing in `src/media/media-token.ts`, capped at the share's own expiry.
- Server routes: `POST/GET /api/workspaces/shares`, `DELETE /api/shares/:id`,
  anonymous `GET /api/public/shares/:token`.
- Standalone public viewer `src/ui/PublicShareView.tsx` routed at `/share/<token>`.
- Share management card in `src/ui/Dashboard.tsx`.
- Tests: `tests/unit/share-service.test.ts`, `tests/security/share-scope.test.ts`,
  `tests/e2e/shares.spec.ts`.

## Design notes

- Only a SHA-256 hash of the token is stored, so a database read cannot reconstruct a live link.
- The raw token is returned exactly once at creation and is never logged; audit output uses a
  redacted prefix.
- Media URLs signed for a share carry no principal and are capped at the share's expiry, so
  revoking or expiring a link also invalidates the media it served.
- Unknown, revoked, not-yet-valid, and expired links all return the same 404, so responses cannot
  be used to probe which links ever existed.

## Checkpoint log

### 2026-10-01 05:30:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["supabase/migrations/20261001020000_slice4_scoped_shares.sql","src/media/share-service.ts","src/media/media-token.ts","src/ui/PublicShareView.tsx","src/ui/Dashboard.tsx","src/server/index.ts","tests/e2e/shares.spec.ts"],"completed":["Scoped read-only share links with revocation, expiry, and share-scoped media signing"],"decisions":["Store only the token hash and return the raw token once","Cap share-signed media URLs at the share expiry so revocation also kills media","Return an identical 404 for unknown, revoked, and expired links to prevent probing"],"evidence":["Live run: anonymous access returned the shared album with 1 item and a 200 media fetch (306 bytes derivative)","Live run: forged token 404; after revoke the share returned 404 and the previously valid media URL returned 401","Live run: not-yet-valid share 404; anonymous workspace, key, and file routes all 401","Playwright: logged-out recipient sees only the album and revocation is immediate","40 unit/integration/security tests pass"],"next_action":"Merge PR after green gates, then continue with the next accepted slice","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0400","timestamp":"2026-10-01T05:30:00Z"} -->

Completed:
- Scoped read-only share links with revocation, expiry, and share-scoped media signing

Evidence:
- Live run: anonymous access returned the shared album with 1 item and a 200 media fetch (306 bytes derivative)
- Live run: forged token 404; after revoke the share returned 404 and the previously valid media URL returned 401
- Live run: not-yet-valid share 404; anonymous workspace, key, and file routes all 401
- Playwright: logged-out recipient sees only the album and revocation is immediate
- 40 unit/integration/security tests pass

Decisions:
- Store only the token hash and return the raw token once
- Cap share-signed media URLs at the share expiry so revocation also kills media
- Return an identical 404 for unknown, revoked, and expired links to prevent probing

Changed:
- supabase/migrations/20261001020000_slice4_scoped_shares.sql
- src/media/share-service.ts
- src/media/media-token.ts
- src/ui/PublicShareView.tsx
- src/ui/Dashboard.tsx
- src/server/index.ts
- tests/e2e/shares.spec.ts

Blocked/uncertain:
- none

Next:
- Merge PR after green gates, then continue with the next accepted slice

Completed (defects found and fixed while verifying):
- A past `validUntil` surfaced the database check constraint as a 500; it is now a clear 400.
- A malformed bearer token reached a `uuid` cast and returned 500 instead of 401; tokens are now shape-checked before querying.
- Renumbered the Playwright/vision task from OCTO-0400 to OCTO-0080, since issue #6 assigns OCTO-0400 to Slice 4 and task IDs are the stable handle across issues, tasks, and checkpoints.

### 2026-10-01 04:40:43 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["tasks/TASK-OCTO-0400-scoped-share-links.md","checkpoints/CURRENT.md"],"completed":["Slice 4 scoped share links closed out after merge"],"decisions":["Record the merge in the task and advance the current projection rather than leaving Slice 4 marked in review"],"evidence":["PR #29 merged into main as 04bea28 with green gates (run 36816234849)"],"next_action":"Begin the next accepted slice after this closeout.","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0400","timestamp":"2026-10-01T04:40:43Z"} -->

Completed:
- Slice 4 scoped share links closed out after merge

Evidence:
- PR #29 merged into main as 04bea28 with green gates (run 36816234849)

Decisions:
- Record the merge in the task and advance the current projection rather than leaving Slice 4 marked in review

Changed:
- tasks/TASK-OCTO-0400-scoped-share-links.md
- checkpoints/CURRENT.md

Blocked/uncertain:
- none

Next:
- Begin the next accepted slice after this closeout.
