# OCTO-0401 Fork-safe multimodal vision audit

<!-- continuity:task {"acceptance":["vision audit is skipped with an explicit logged reason when INFERHUB_API_KEY is absent","same-repo runs, including every push to main, still perform the real audit and assert a score","fork pull requests are no longer blocked by an unsatisfiable secret dependency","no pull_request_target workflow is introduced, so untrusted PR code is never checked out with secrets"],"depends_on":["OCTO-0080"],"goal":"Make the Playwright multimodal vision audit fork-safe so fork pull requests are not blocked by a repository secret they can never receive","id":"OCTO-0401","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/3","next_action":"Merged in PR #28 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P1","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Keep the vision quality gate honest for same-repo runs without making it an unsatisfiable required check for external contributors."} -->

- Status: completed
- Priority: P1
- Branch: `task/OCTO-0401-fork-safe-vision`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/3

## Goal

The vision audit added in OCTO-0080 runs inside the required `gates` job. Fork pull requests never receive repository secrets, so `INFERHUB_API_KEY` is absent there by design, and the audit's assertions would fail every fork PR on a dependency that cannot be satisfied. Extract the audit so it skips with an explicit reason where the key cannot exist, while every same-repo run keeps performing and asserting the real audit.

## Prepared on this branch

- `tests/e2e/vision-audit.ts`: shared helper exposing `visionAuditAvailable()` and `auditPage(page, screenName)`, which returns `null` (and logs the reason) when the credential is unavailable.
- `tests/e2e/dashboard-ui.spec.ts`: switched to `auditPage`, asserting the vision score only when a result is returned.
- Deliberately does not use `pull_request_target`, because checking out untrusted PR code with secrets present is a standard exfiltration footgun.

## Checkpoint log

### 2026-10-01 04:09:04 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["tests/e2e/vision-audit.ts","tests/e2e/dashboard-ui.spec.ts"],"completed":["Fork-safe multimodal vision audit that skips with a logged reason when the InferHub key is unavailable"],"decisions":["Skip the audit where the secret cannot exist rather than fail an unsatisfiable required check","Do not adopt pull_request_target, which would run untrusted PR code with secrets present"],"evidence":["PR #28 merged into main as 284f990 with green gates (run 36813769358)","Local run with the key present: all 3 E2E specs pass with the vision audit reporting model, score, and notes for the login screen and the dashboard"],"next_action":"Continue with the next accepted slice (#6 scoped share links)","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0401","timestamp":"2026-10-01T04:09:04Z"} -->

Completed:
- Fork-safe multimodal vision audit that skips with a logged reason when the InferHub key is unavailable

Evidence:
- PR #28 merged into main as 284f990 with green gates (run 36813769358)
- Local run with the key present: all 3 E2E specs pass with the vision audit reporting model, score, and notes for the login screen and the dashboard

Decisions:
- Skip the audit where the secret cannot exist rather than fail an unsatisfiable required check
- Do not adopt pull_request_target, which would run untrusted PR code with secrets present

Changed:
- tests/e2e/vision-audit.ts
- tests/e2e/dashboard-ui.spec.ts

Blocked/uncertain:
- none

Next:
- Continue with the next accepted slice (#6 scoped share links)
