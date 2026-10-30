# OCTO-0101 Hands-off auto-merge policy

<!-- continuity:task {"acceptance":["repository auto-merge is enabled","main requires only the aggregate gates check","no review approval is required on main","branches are not required to be up to date, so a PR merges as soon as gates is green","AGENTS.md states auto-merge is mandatory and requires no human approval","an automated workflow arms auto-merge on every same-repo pull request"],"depends_on":["OCTO-0001"],"goal":"Make auto-merge fully automatic for every agent with no extra approval requirement","id":"OCTO-0101","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/2","next_action":"Continue with the next accepted slice.","owner":"Pukujan","priority":"P0","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"The owner requires every agent to merge automatically without an approval step."} -->

- Status: completed
- Priority: P0
- Branch: `task/OCTO-0101-auto-merge-policy`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/2

## Goal

Make auto-merge fully automatic for every agent, with no extra approval requirement and no manual
rebasing step.

## Owner instruction

"make sure auto merge is enabled and every agent does it automatically without extra approval
requirement"

## Applied configuration

| Setting | Value |
| --- | --- |
| Repository `allow_auto_merge` | enabled |
| `main` required status checks | `gates` only |
| Required pull-request reviews | none |
| "Require branches to be up to date" (`strict`) | **off** |
| `delete_branch_on_merge` | enabled |
| `allow_update_branch` | enabled |
| `.github/workflows/auto-merge.yml` | arms squash auto-merge on every same-repo PR |

The `strict` change matters: with it on, every PR had to be rebased onto `main` after any other
merge before auto-merge could complete, which produced a manual step on nearly every slice.

## Checkpoint log

### 2026-10-01 09:00:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["AGENTS.md","checkpoints/CURRENT.md"],"completed":["Hands-off auto-merge: strict up-to-date requirement removed and policy made explicit"],"decisions":["Turn off require-branches-to-be-up-to-date so auto-merge completes without manual rebasing","Keep gates as the only required check and no review requirement"],"evidence":["gh api branch protection shows strict=false and contexts=[gates]","PR #34 merged automatically after the strict change with no manual merge step","Repository settings show allow_auto_merge=true, delete_branch_on_merge=true, allow_update_branch=true"],"next_action":"Continue with the next accepted slice","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0101","timestamp":"2026-10-01T09:00:00Z"} -->

Completed:
- Hands-off auto-merge: strict up-to-date requirement removed and policy made explicit

Evidence:
- `gh api` branch protection shows `strict=false` and contexts `[gates]`
- PR #34 merged automatically after the change, with no manual merge step
- Repository settings show `allow_auto_merge=true`, `delete_branch_on_merge=true`, `allow_update_branch=true`

Decisions:
- Turn off "require branches to be up to date" so auto-merge completes without manual rebasing
- Keep `gates` as the only required check and require no review approval

Changed:
- AGENTS.md
- checkpoints/CURRENT.md

Blocked/uncertain:
- none

Next:
- Continue with the next accepted slice
