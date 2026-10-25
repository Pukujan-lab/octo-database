# Issue Log Entry (local draft)

> Draft only. Not filed. Destination and filing action require explicit owner direction.
> Prepared 2026-10-17 from the tracing/capability-contracts discussion on branch `aba-vault-key-table`.

---

## Issue Type
`observational`

## Filer Origin
`human-via-agent`

## Filing Authorization Evidence
`claimed`

## Session, Authorization Evidence, and Instruction Reference
- Session reference: Claude Code session, 2026-10-17, branch `aba-vault-key-table`
- Claimed instruction/source: owner asked for an OTel/tracing capability, then asked that the resulting direction be written up as an issue-log proposal
- Authorization evidence: claimed

## Content Author Account or Runtime Identity
`agent:claude-code/octo-tracing-session-2026-10-17`

## Directing Human GitHub Account ID
`137629468`

## Destination Repository
`Pukujan/octo-database`

## Ontology Versions Used
`oio=1.0.0; project=1.0.0`

## Project Priority Path
`5`

## Project Priority Concept ID
`pukujan-octo-database:priority-5`

---

## Affected App, Adopter, Users, or Systems

Workspace consumers — agents and applications authenticating to Octo with a workspace-scoped key. Currently, an agent that needs traces, evals, prompt management, or long-range analytics must provision those systems itself, outside Octo's credential boundary, once per project. Octo's `PROJECT.md` product model already names Parquet and DuckDB for "long-term operational, observational, and analytical history" (lines 18, 90), but the repository contains no DuckDB or Parquet code.

## Observed Consequence and Workaround

Observed:

- Telemetry appears nowhere in Octo. `PROJECT.md` has zero occurrences of trace, log, eval, or telemetry. `SLICE_MAP.md` lists ten slices, none for observability.
- The analytics half of the same gap is already real: `docs/productization/slices/07-historical-analytics.md` is marked **DRAFT — not locked, do not implement**, and `grep -rin "duckdb\|parquet" src/` returns nothing. Adopters were previously told analytics ran on "Octo's DuckDB and Parquet" and found neither (#149), and one agent bypassed Octo's managed layer entirely (#162).
- Capability descriptors are prose. `src/api/capabilities.ts` describes each operation in an English `description` string with a `path` template; nothing declares request or response shape. An agent can discover that `workspaces.query` exists but cannot validate that `params` is an array or predict the `SQL_ERROR` body.

Workaround today: each adopter runs its own collector/Phoenix/Langfuse instance and holds its own credentials, outside Octo's auth and routing.

## Evidence Confidence
`supported`

## Impact if Unresolved
`low`

## Likelihood
`observed`

## Exposure
`not-currently-exposed`

## Exposure Duration
Not applicable — no tracing capability exists to be degraded; the analytics gap is documented and unshipped.

## Recoverability
`unknown`

## Recovery Evidence
Not applicable to the observation. Recovery for the analogous analytics gap required adopters to stand up their own infrastructure (#162).

## Risk if the Observation Remains Unresolved

Agents continue to re-provision the same observability stack per project, each time with its own credentials and no workspace binding. That is friction and duplicated work, not data loss or a boundary breach — hence `low`. The sharper risk is a repeat of #149: roadmap prose in `PROJECT.md` ("Parquet… observational history") reads as shipped capability while `src/` contains none, and adopters build against a surface that does not exist.

## Risk Introduced by a Proposed Change

Moderate and bounded. A new authenticated ingress route adds a request path that forwards bytes to a new upstream; misconfiguration could expose the tracing backend or forward spans into the wrong project. Mitigated by deriving the Phoenix project name from the authenticated workspace (never from the caller), keeping the backend on loopback/Tailscale, and holding the upstream credential server-side. No change to existing routes, schema, or durable state.

## Product or Release Relevance
`supports`

## Named Product Outcome and Cost of Delay

Supports `PROJECT.md` "Product success" #10 ("reuse mature systems rather than rebuilding incomplete substitutes") and the owner-stated goal that one API lets an agent stand up the whole production flow for a workspace. Cost of delay: every new agent project keeps building its own tracing stack; the platform's capability story stays incomplete for the most common agent need.

## Cost of Delay

Low-to-moderate. No accepted slice is blocked. The cost compounds per new agent project rather than accruing to one release.

## Smallest Useful Product Slice

1. One authenticated ingress route family for OTLP/HTTP (`POST /api/workspaces/:id/otel/v1/traces`, optionally `metrics`/`logs`), which authenticates with the existing Octo key machinery, derives the Phoenix project from the workspace, and forwards raw bytes with `x-project-name` injected and the Phoenix API key attached. No OTLP parsing.
2. One capability descriptor so the path is discoverable through `/api/capabilities`.
3. Phoenix on the Mac host: one instance, Postgres backend, own database, `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS` set, bound to loopback/Tailscale only.

Explicitly excluded from the smallest slice: an Octo-side trace browser, capability manager, manifest object, application runtime, and deployment pipeline.

## Provenance and Context

- Destination repository: `Pukujan/octo-database`
- Source revision/environment: branch `aba-vault-key-table`, head `bf1c777`, 2026-10-17
- Observer: Claude Code agent, directed by owner `Pukujan` (137629468)
- Ontology versions: OIO 1.0.0 / project 1.0.0

## Reproducibility Steps and Evidence

1. `grep -rin "duckdb\|parquet" src/` → no matches; `grep -rin "otel\|opentelemetry\|tracing" src/` → no telemetry implementation.
2. `head -5 docs/productization/slices/07-historical-analytics.md` → "Status: DRAFT — pending independent critique and owner acceptance. Not locked."
3. `grep -i "observ\|trace\|log\|eval\|orchestrat" PROJECT.md` → only "observational history" (Parquet), no telemetry capability.
4. `src/api/capabilities.ts:24-256` — 33 descriptors, each with `action`, `method`, `path`, `requiredScope`, `description`; none carries a request/response schema.
5. `src/routes/capabilities.ts:48-106` — filters by scope, workspace binding, and provider configuration; there is no per-workspace capability *status*.
6. Phoenix storage scope (upstream docs): self-hosted Phoenix supports SQLite and PostgreSQL only; ClickHouse is not a Phoenix backend. One instance is one tenant; multi-team means multiple instances. `x-project-name` OTLP/HTTP routing exists in Phoenix ≥15.5.0. Retention is configurable via `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS`.

## Citations and References

- `PROJECT.md:7-9` (glue mature systems), `:18` (Parquet), `:90` (observational history), `:97` (success #10)
- `src/api/capabilities.ts:24-256` (prose descriptors)
- `src/routes/capabilities.ts:48-106` (discovery filtering)
- `src/server/provisioning.ts:184-211` (workspace DB provisioning — the existing activation primitive)
- `src/routes/vault-relay.ts` (existing credential-swap relay pattern)
- `docs/productization/slices/07-historical-analytics.md` (DRAFT analytics slice)
- `docs/research/2026-10-13-platform-audit-observability-oio-and-placement.md` (no read-path logging; deferred orchestration)
- Issues #149 (roadmap read as shipped), #162 (adopter bypassed the managed layer), #13 (DuckDB/Parquet slice)
- Phoenix: https://arize.com/docs/phoenix/self-hosting/architecture ; https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-projects ; https://arize.com/docs/phoenix/settings/data-retention

## Non-Binding Proposed Next Actions

*(proposal — none of this authorizes implementation)*

1. Decide the capability-mechanism vocabulary and record it in `PROJECT.md`: provisioned (Postgres), derived (graph), proxied (traces), delegated (evals), owned state (orchestration), compute (DuckDB). The current model lists engines without distinguishing these.
2. Adopt one rule for discovery: a capability is advertised in `/api/capabilities` only after it is wired end to end; roadmap entries are marked as roadmap. This is the cheapest guard against #149 recurring.
3. Ship the smallest tracing slice above, with Phoenix deployed dark-but-wired (per the recurring "engines ship dark" pattern) and one end-to-end verification that a workspace key can ingest a span and read it back in Phoenix's console under the workspace's project.
4. Separately, decide the typed-contract question: whether `CapabilityDescriptor` gains a request/response schema. This is the prerequisite for any manifest or capability-manager work, and should not be built before it.
5. Keep out of scope until the owner asks: capability manager/lifecycle object, application runtime, build/deploy pipeline, templates/bundles, HA/audit/rate-limit "production readiness" bundles.
