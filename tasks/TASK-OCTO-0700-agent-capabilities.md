# OCTO-0700 Scoped agent identities and capability discovery

<!-- continuity:task {"acceptance":["agent token is minted with explicit scopes and a workspace binding","capability discovery describes how to call Octo, filtered to the token's granted scopes","a read-only token can list and read allowed workspace files","a read-only token cannot delete or upload (403)","a token cannot enter another workspace (403)","no provider, database, or infrastructure credential is disclosed","agent actions produce attributable audit records","revocation takes effect immediately and unknown scopes are rejected at mint time"],"depends_on":["OCTO-0200","OCTO-0600"],"goal":"Give agents scoped machine identities that use the same Octo platform boundary as human apps","id":"OCTO-0700","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/9","next_action":"Merged in PR #33 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P1","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Let automation act through Octo without ever holding infrastructure master credentials."} -->

- Status: completed
- Priority: P1
- Branch: `task/OCTO-0700-agent-capabilities`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/9

## Goal

Give AI agents and automation scoped machine identities that use the same Octo platform boundary as human-facing apps. A token proves a principal and its capabilities; it never carries infrastructure master credentials.

## Prepared on this branch

- Capability discovery `src/api/capabilities.ts` (stable action list, scope filtering, auth guidance).
- Scope enforcement on every agent-callable route in `src/server/index.ts`.
- `GET /api/capabilities` filtered to the presented token's scopes.
- `DELETE /api/keys/:id` so a leaked agent token can actually be withdrawn.
- Explicit scope selection at mint time; unknown scopes rejected with 400.
- Agent action attribution into the activity feed.
- Tests: `tests/unit/capabilities.test.ts`, `tests/security/agent-scopes.test.ts`,
  `tests/e2e/agent-tokens.spec.ts`.

## Design notes

- Capability discovery describes **how** to call Octo; token scopes define **what** the
  principal may do. The description is never the enforcement mechanism -- every call is
  authorized server-side against the token's scopes.
- The default scope set is non-destructive (`read`, `write`, `files`); `delete` and
  `admin` must be requested explicitly, so a token cannot be destructive by omission.
- Human sessions are not scope-limited; only API-key callers are.
- Enforcement is server-side on token scopes, so text inside a retrieved document cannot
  escalate authority (covered by the indirect prompt-injection test).

## Checkpoint log

### 2026-10-01 07:00:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["src/api/capabilities.ts","src/server/index.ts","tests/e2e/agent-tokens.spec.ts","tests/security/agent-scopes.test.ts","tests/unit/capabilities.test.ts"],"completed":["Scoped agent tokens with capability discovery, server-side scope enforcement, audit attribution, and revocation"],"decisions":["Default scopes exclude delete and admin so a token is never destructive by omission","Capability discovery is filtered to granted scopes but enforcement stays server-side","Add DELETE /api/keys/:id because a token that cannot be revoked is a liability"],"evidence":["Live: read-only token discovered 5 read/files actions and listed files (200)","Live: same token was refused delete (403) and upload (403)","Live: token could not reach another workspace (403)","Live: capability payload contained 0 infrastructure credential strings","Live: agent upload and delete were attributed in the activity feed","Live: after DELETE /api/keys/:id the token returned 401; revoking a non-owned key returned 404","Live: unknown scope rejected at mint time (400)","62 unit/security tests and 2 agent E2E tests pass"],"next_action":"Merge PR after green gates, then continue with the next accepted slice","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0700","timestamp":"2026-10-01T07:00:00Z"} -->

Completed:
- Scoped agent tokens with capability discovery, server-side scope enforcement, audit attribution, and revocation

Evidence:
- Live: a read-only token discovered 5 read/files actions and listed files (200)
- Live: the same token was refused delete (403) and upload (403)
- Live: the token could not reach another workspace (403)
- Live: the capability payload contained 0 infrastructure credential strings
- Live: agent upload and delete actions were attributed in the activity feed
- Live: after DELETE /api/keys/:id the token returned 401; revoking a non-owned key returned 404
- Live: an unknown scope was rejected at mint time (400)
- 62 unit/security tests and 2 agent E2E tests pass

Decisions:
- Default scopes exclude delete and admin so a token is never destructive by omission
- Capability discovery is filtered to granted scopes but enforcement stays server-side
- Add DELETE /api/keys/:id because a token that cannot be revoked is a liability

Changed:
- src/api/capabilities.ts
- src/server/index.ts
- tests/e2e/agent-tokens.spec.ts
- tests/security/agent-scopes.test.ts
- tests/unit/capabilities.test.ts

Blocked/uncertain:
- none

Next:
- Merge PR after green gates, then continue with the next accepted slice
