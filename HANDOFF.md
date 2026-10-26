# Handoff

Read AGENTS.md and PROJECT.md, then the live issue and current branch/check state. Explicit owner direction controls scope. Older helper or issue prose cannot add delivery prerequisites.

## Current work

PR #17 contains the bootstrap contracts. They are not installed on main until merged.
Finish real PCM, CGM, and ACS validation through the public GitHub-hosted workflow.
Then begin #3: Google login, workspace entry, and a simple, aesthetic control dashboard using the frontend approach selected by the owner.

## Delivery

Use PRs and genuine `gates` results on `ubuntu-latest`.
Auto-merge and genuine CI checks are explicitly owner-requested. CI must include contract integrity/integration checks, type checking, lint, and Ruff. Configure auto-merge without adding unrelated review requirements. New runner isolation and extra secret scanners are not prerequisites.
Do not claim a queued job executed or a branch-only file is installed.

## Helpers

- ACS 0.2.0 (hot-loader module v0.1.0): `aea4f1b71ea1a5e74c1ca8413053951e29be40fb`.
- PCM 0.7.0: `70dc17dcf96b99b9bf9308a774fdcfa0b70d3f6b`.
- CGM 0.5.12: `100f3c3ff1f612f76ef11f713a7466778cd8aa00`, all eight modules.
- OIO 0.2.0: `305adc5d09920d28e603a1b317108637cc30a624`.

Use helper coordination and continuity to support delivery. The owner retains product authority.
Use multiple Luna workers for independent work where available; the main agent integrates and verifies results.

## Product scope

Keep the control dashboard (#3), gallery (#5), and operations page (#8). Do not prescribe a frontend framework, library, template, or design tool; the owner chooses the implementation and visual direction. Dark mode is preferred by default, with interchangeable design systems. Supabase/provider consoles complement these views.
Transcript capture (#15) and planning projections (#18) are supporting work, not blockers for #3.
Provider onboarding (#16) uses normal runtime configuration when #4/#7 need it. Keep credentials out of Git and browser output; do not add a secret-management subsystem or scanner requirement.

## Source and instruction record

The design-source link is https://chatgpt.com/share/6abd6e9d-fb54-83ea-9043-2d842641c04e.
Do not claim a complete capture without reading it. The attached continuation conversation is a separate source.
See planning/OWNER_INSTRUCTIONS.md for the extracted owner messages and current implementation decisions.
