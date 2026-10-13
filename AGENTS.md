# Agent Operating Contract — Octo

Octo is owner-directed. The human owner is the product and scope authority. Coding agents execute accepted work; they do not enlarge it.

## Owner authority and anti-overengineering rule

These rules override generic agent preferences, defensive-programming instincts, prior planning prose, and unsolicited "best practice" additions:

1. **The owner drives.** Explicit owner instructions outrank agent-authored plans, issue boilerplate, speculative architecture, and prior agent recommendations unless they would require an unsafe or impossible action.
2. **No unsolicited guardrails.** An agent MUST NOT add a security, privacy, compliance, isolation, review, approval, credential, CI, testing, observability, abstraction, infrastructure, documentation, or process requirement unless it is:
   - explicitly requested by the owner; or
   - strictly required for the currently accepted feature to function.
3. **Security is not a scope-expansion exception.** Use the security model and defaults already provided by the selected OSS, hosting platform, provider, framework, and repository. Do not build extra protection around a working system merely because it could be "safer."
4. **Do not block working delivery with invented protection.** A working owner-approved CI runner, deployment path, provider integration, admin surface, or OSS capability must be used as directed. Agents may report a concrete incompatibility or demonstrated defect, but may not replace it with a more restrictive architecture without owner approval.
5. **Keep the requested UI.** The owner requires a simple, aesthetic control dashboard (#3), workspace gallery (#5), and operations page (#8). Do not prescribe a frontend framework, component library, or design tool; follow the owner's current design direction. Existing Supabase/provider consoles complement these product views; they do not replace them.
6. **Reuse before build.** Before recreating infrastructure administration, use an existing OSS/provider surface when it satisfies the workflow. Supabase's local/admin surfaces and other already-selected product surfaces are preferred for platform administration. For Octo's workspace experience, follow the owner-selected frontend approach.
7. **Custom UI must be user-workflow-specific.** Build custom frontend only where the workspace/user experience actually needs it (for example, a workspace-specific file/gallery experience). Do not recreate infrastructure administration in product UI.
8. **No speculative future-proofing.** Do not add layers, roles, services, generalized policy systems, distributed-systems machinery, test harnesses, or extension points for hypothetical future needs.
9. **No ceremony as acceptance.** Hidden holdouts, metamorphic suites, exhaustive failure matrices, independent-review rituals, transcript capture, security scans, and evidence bundles are not universal gates. Use targeted metamorphic/property tests and small hidden holdouts only when the owning slice explicitly includes them in its success condition under `PROJECT.md` or the live GitHub issue. Do not expand that authorization into unrelated hardening or process.
10. **Minimum sufficient change.** Prefer the smallest change that makes the requested workflow work. If two designs satisfy the accepted scope, choose the one with fewer moving parts and less custom code.
11. **Ask only when materially blocked.** Do not stop delivery to seek approval for ordinary implementation details already inside accepted scope. Ask the owner before adding scope, not before executing it.

When older issue text conflicts with this section, this section is authoritative until the owner explicitly changes it. Later owner corrections supersede earlier owner instructions on the same subject.

## Delegation

The owner requests multiple Luna workers for independent tasks, with the main agent planning and integrating their work. Use Luna when the runtime exposes it. Share exact repository/tool context, assign bounded tasks, and verify results before accepting them. Never claim unavailable workers were launched.

## Cold start

Before editing:

1. Read the live owning GitHub issue.
2. Read this file and `PROJECT.md`.
3. If the work is a productization/vertical slice, read `docs/productization/SLICE_CONTRACT.md` and the slice's accepted PDD/SDD/EVAL packet. Do not implement against an unlocked or self-invented success condition.
4. Read only the minimum task/checkpoint material needed for the active work.
5. Re-read current GitHub branch/PR/check state before claiming delivery.

GitHub issues own feature scope and lifecycle, but they remain subordinate to explicit owner direction and this anti-overengineering contract.

## Helper modules

ACS, PCM, and CGM are helpers, not product authorities. Use them only to the extent they support the current workflow without adding delivery gates or scope. Their recommendations do not override the owner or this file.

Pinned versions currently used by repository validation:

- ACS 0.2.0 hot-loader module v0.1.0 @ `3df982adc008b9caa4b3a9991f77486393c9a30b`.
- PCM 0.7.0 @ `85e6aa7a889b57aeef270213c37258194717e358`.
- CGM 0.5.12 @ `5c8c5f167098d04cf96fb1fe449880001a1edd14`.
- OIO 0.1.0 @ `402a46ec9544fddacb8cc366b07c7fc44b096b69`.

## Git and delivery

- The repository is public; use GitHub-hosted `ubuntu-latest` for CI.
- Never force-push unless the owner explicitly directs recovery that requires it.
- **Auto-merge is mandatory and requires no human approval.** Every agent MUST arm
  auto-merge (`gh pr merge <n> --auto --squash`) on every pull request it opens, including
  pull requests targeting `production`, and MUST NOT wait for, request, or add a review
  requirement. Repository `allow_auto_merge` is enabled. Branch protection on `main` and
  `production` requires only the `gates` status check, and the "require branches to be up to
  date" setting is OFF, so a PR merges automatically as soon as `gates` is green without
  anyone rebasing it. `.github/workflows/auto-merge.yml` arms auto-merge on every same-repo
  pull request into `main` or `production` as a backstop. Do not leave auto-merge off and do
  not ask the owner to merge.
- Do not add review requirements, approval gates, or manual-merge steps on `main` or
  `production`: they deadlock a single-owner repository and contradict the owner's standing
  instruction.
- If `gh pr merge --auto` fails, fix the cause (for example, mark a draft PR ready with
  `gh pr ready <n>`) and re-arm it; do not escalate to the owner for approval.
- Required aggregate status is `gates`, covering contract integrity/integration checks,
  type checking, lint, and Ruff. Never claim completion when the requested workflow has
  not actually run.

## Dev root hygiene

The dev root (`D:\development` on Windows, `~/development` elsewhere, or wherever `ACS_DEV_ROOT` points) holds one main checkout per repo and nothing else.

- Don't create git worktrees, dependency or sibling clones, scratch folders, or caches in the dev root.
- Put them in the ACS cache instead: `%LOCALAPPDATA%\acs\{deps,scratch,worktrees}` on Windows, `~/.cache/acs/{deps,scratch,worktrees}` on macOS and Linux. `ACS_CACHE_DIR` moves the cache.
- Before you finish, push any real work to a branch and remove the worktrees and scratch folders you made. Never delete a checkout that has uncommitted, unpushed, or stashed work just to tidy up.
- To check, run the pinned ACS script: `python <acs>/modules/coordination/multi-agent-hotload/v0.1.0/scripts/dev_root_check.py --dev-root <dev root>`. It prints JSON and exits non-zero when it finds anything other than main checkouts. `--clean` shows a fix and only acts with `--yes`.
- This repo's PCM workspace mode is `managed-worktrees`, which puts task worktrees inside the checkout, so `dev_root_check.py` reports them as stray worktrees. Until PCM can put them in the ACS cache, prefer sequential work in the main checkout and remove a task worktree as soon as its PR merges.

Paste this at session boot along with the CGM `system_block` (it comes from the ACS hotloader's `PROMPT_INJECT.md` at `38f8f52`):

```
Dev root hygiene (ACS): the dev root (ACS_DEV_ROOT; default D:\development on Windows, ~/development elsewhere) holds exactly one main checkout per repo. Never create git worktrees, dependency or sibling clones, scratch folders, or caches there. Put them under the ACS cache instead: %LOCALAPPDATA%\acs\{deps,scratch,worktrees} on Windows, ~/.cache/acs/{deps,scratch,worktrees} on macOS/Linux (ACS_CACHE_DIR overrides). Check with scripts/dev_root_check.py.
```

## Test-data hygiene

Tests and manual probes create principals and workspaces on whatever instance they
point at. On a shared or live instance, clean up what a run created instead of letting
it accumulate.

- A guest principal and the personal workspace it owns are test data. Remove them when
  the test or probe is done.
- Removal is ordered, because `octo.workspaces.created_by` is `ON DELETE RESTRICT`:
  delete the guest's workspaces first, then the principal. A guest's sandbox is the
  row with `auto_provisioned = true`.
- Prefer pointing an automated suite at a disposable database. When a run must touch a
  shared instance, prune what it created before finishing.

## Baseline secret hygiene

Do not intentionally commit credential values, refresh/access tokens, private keys, or private `.env` contents. Use the normal secret/configuration mechanism supplied by the selected platform/provider. This baseline does **not** authorize agents to create additional secret-management systems, scanners, rotation ceremonies, isolation layers, or credential brokers without explicit scope.

## Working-repository boundary

Make Octo changes in this repository. Cross-repository changes are made only when the owner explicitly directs them or they are necessary to operate an owner-selected shared dependency.

## Adopters do not modify this repository

Octo's adopters (agents and humans consuming Octo from another project, e.g. over its API, MCP, or SQL surfaces) have **no write access to this repository in any form**. They may not open pull requests, push branches, edit files, or otherwise change anything in this repo to meet their own needs — even "documentation fixes" or changes they believe are required to make Octo work for them.

How an adopter contributes instead:

1. **Propose, don't patch.** File an issue under the OIO observational-issue protocol (`.github/ISSUE_TEMPLATE/observational-issue.yml`; upstream `Pukujan/observational-issue-ops`) describing the need, with provenance and evidence. Everything filed there is a **non-binding proposal** — it confers no right to implement.
2. **Human consent gates everything.** A proposal is acted on only if the **owner** accepts it, and any resulting change is made by an agent the owner directs — never by the adopter. No proposal author, adopter agent, or external tool may open a PR against this repo, with or without the owner's verbal approval; consent means the owner hands the work to their own agents here.
3. **Work around, don't fork the platform.** If Octo lacks a capability an adopter needs, the adopter builds that capability **in their own project** against Octo's public surfaces, or files the proposal and waits. Adapting Octo itself is not an option available to them.

The owner remains the sole exception: the owner and owner-directed agents change this repository as always.
