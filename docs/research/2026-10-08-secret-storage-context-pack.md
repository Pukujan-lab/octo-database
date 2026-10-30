# Secret storage — context pack

**Date:** 2026-10-08 · **Status:** briefing for a planning agent. Research only. Nothing here authorizes implementation, and no design is decided.
**Owning issue:** [#92](https://github.com/Pukujan-lab/octo-database/issues/92) — "Future feature: built-in secret storage (secret boxes, rotatable, decoy and bi-temporal keys)".

Octo is a self-hosted control plane for workspaces, files, and agents, running on a Linux host called gravebuster. This pack is the briefing for deciding how Octo should handle secrets.

## TL;DR / state of play

- Octo has **no secret-storage feature and no slice for one**. The accepted productization slices are 0–9 (`docs/productization/SLICE_MAP.md:7-18`) and none is about secrets.
- The **owning issue is #92**, which is explicitly *backlog only* and says not to implement without the owner's ("Alex's") explicit go. It asks for a lightweight, Octo-native store with secret boxes, rotation with version history, decoy/canary keys, and bi-temporal history, replacing a self-hosted Infisical removed 2026-10-03 for ~650 MB idle RAM.
- Issue **#184** records the intended *grant*: a coding agent holds a workspace key plus a long-running secret-store key that opens only its workspace's box.
- Octo already has a **provider-credential contract** (`docs/security/RUNTIME_SECRETS.md`) for R2 and Google Drive — but that is runtime configuration injected into the server, **not** a user-facing secret store. The two are different problems.
- The original planning transcript names **OpenBao** as the eventual secrets component and says the platform should *broker* short-lived credentials rather than store secrets itself — but the same transcript says "**No OpenBao initially**" and lists OpenBao under "**Do not build yet**" (`:8747`, `:9017`). Issue #92 says the store is *in Octo*. See "The in-Octo vs. OpenBao question" below.
- **Existing temporary infrastructure:** an ephemeral one-time secret *drop* is running on gravebuster today, built to hand credentials to an agent without pasting them into a chat transcript. It is **transfer, not storage**, and it is documented here as existing infra, not as a proposed design.

---

## 1. Governance constraints that bear on this topic

From `AGENTS.md` (the owner-authority / anti-overengineering contract). The rules most relevant to secret storage:

- **Owner drives** (`AGENTS.md:9`): explicit owner instructions outrank agent-authored plans and prior planning prose. Issue #92 is the owner's own issue; the transcript is advisory planning input.
- **No unsolicited guardrails** (`AGENTS.md:10`): an agent must not add a security, credential, isolation, review, or process requirement unless the owner requested it or it is strictly required for the accepted feature to function.
- **Security is not a scope-expansion exception** (`AGENTS.md:13`): use the security model and defaults already provided by the selected OSS/provider rather than building extra protection.
- **Reuse before build** (`AGENTS.md:16`): before recreating infrastructure administration, use an existing OSS/provider surface when it satisfies the workflow.
- **No speculative future-proofing** (`AGENTS.md:18`) and **minimum sufficient change** (`AGENTS.md:20`): prefer the smallest change with fewer moving parts and less custom code.
- **Baseline secret hygiene** (`AGENTS.md:89-91`): do not commit credential values, tokens, or private keys; use the normal secret/configuration mechanism supplied by the selected platform. This baseline does **not** authorize agents to create additional secret-management systems, credential brokers, rotation ceremonies, or isolation layers without explicit scope.

A planning agent should read the full contract; the above is the subset that constrains this topic.

## 2. What Octo already has: the runtime secret contract

`docs/security/RUNTIME_SECRETS.md` is Octo's own provider-credential contract, owned by issue #16. It covers **R2 and Google Drive credentials only**:

- Provider credentials are **runtime inputs**, never planning data, browser configuration, or agent-readable capability data (`docs/security/RUNTIME_SECRETS.md:5`).
- Named secrets are `GOOGLE_DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN` and `R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET/ENDPOINT` (`docs/security/RUNTIME_SECRETS.md:7-20`).
- The runtime boundary: "Production/development runtime secret storage injects credentials into the server/worker process. Browser code and agent principals call Octo APIs and receive scoped logical capabilities only." (`docs/security/RUNTIME_SECRETS.md:23-25`).
- Fail-closed: missing/invalid credentials disable the provider operation; errors must not echo secrets (`docs/security/RUNTIME_SECRETS.md:43-47`).

**How this differs from a user-facing secret store.** RUNTIME_SECRETS is about a small, fixed set of *platform-operator* credentials that Octo itself uses to talk to R2 and Drive. It has no notion of per-workspace boxes, per-item metadata, user-supplied secrets, rotation history, decoys, or agent-facing retrieval. A user-facing store (issue #92) is a different component with different requirements: retention, revocation, per-principal scoping, and audit. The contract above is the *closest existing analogue* and establishes Octo's house style (named secrets, runtime injection, fail-closed, no values in prose), but it does not cover the #92 feature.

## 3. Planning evidence: the transcript

`planning/source/chatgpt-storage-platform-transcript-v1.md` is the original design transcript (captured verbatim under issue #15). The passages below are the authoritative planning evidence for this topic. All quotes are verbatim.

**Integrations / secrets UI — the server holds the secret, the app references an id** (`:5654-5674`):

> ```
> # 9. Integrations / secrets
> ...
> But never display full credentials.
> Your application references:
> credential_id
> and the server holds the actual secret.
> ```

**Agents default to no secret read** (`:7769-7782`):

> The agent should still only have capabilities such as:
> ```
> agent_37
> workspace = research-A
> files.read       yes
> files.write      yes
> files.delete     no
> secrets.read     no
> admin            no
> external.send    no
> ```

**One stable API; agents do not manage or rotate credentials** (`:7855`):

> I'd make the platform expose **one stable API surface**, but keep the storage/analytics engines modular underneath. The agent should request capabilities through that API; it should **not** be responsible for managing or rotating infrastructure credentials itself.

**The OSS stack table names OpenBao for secrets** (`:7876`):

> | Secrets | **OpenBao** | API keys, short-lived DB credentials, rotation |

**The `/v1/secrets/*` namespace and the agent-visible capability list** (`:8129-8152`):

> ```
> /v1/files/*
> /v1/data/*
> /v1/analytics/*
> /v1/graph/*
> /v1/vector/*
> /v1/jobs/*
> /v1/agents/*
> /v1/secrets/*
> ```
> Agent sees:
> ```
> Platform API
>      │
>      ├── files.search()
>      ├── files.read()
>      ├── data.query()
>      ├── analytics.query()
>      ├── graph.query()
>      ├── rag.search()
>      ├── jobs.submit()
>      └── datasets.create()
> ```

**Advanced users may bypass the single API** (`:8169-8213`): the default is one platform token; "Advanced users can request dedicated credentials: Postgres credential / R2 credential / Neo4j credential / analytics credential — when they really need native connectivity."

**"The agent should NOT rotate keys"** (`:8245-8296`):

> Don't give an agent:
> > Here's the master R2 credential. Rotate it when appropriate.
>
> Instead:
> ```
> Agent
>   │
>   │ "I need R2 write access"
>   ▼
> Platform
>   │
>   ▼
> OpenBao / credential broker
>   │
>   ▼
> temporary credential
> expires in 15 minutes
> ```
> **OpenBao** is designed specifically for this type of secret lifecycle. It can store secrets, generate dynamic credentials, issue leases and revoke them. Its database secrets engine can generate per-service credentials rather than applications permanently storing database passwords.
> ...
> And the **control plane**, not the LLM, determines:
> ```
> creation
> scope
> duration
> rotation
> revocation
> ```
> Agents should be able to request access. They should not own access policy.

**Control-plane responsibilities include "credential brokerage," and the explicit anti-goal** (`:8345-8446`):

> ```
> CONTROL PLANE API
> │
> ├── Workspaces / IAM
> ├── capabilities
> ├── credential brokerage
> ├── routing
> ├── retention policies
> └── audit
> ```
> ...
> ```
> ├── OpenBao
> │   └── secrets/leases/rotation
> ```
> ...
> Your platform decides:
> > Agent 91 needs database access.
> OpenBao decides:
> > Here's a short-lived credential; revoke it in 15 minutes.
>
> That's the separation I would preserve as you build this. It lets the platform remain **one frictionless interface** without turning your own API server into a badly reimplemented database, graph engine, analytics engine, secret manager, job scheduler, and object store all at once.

**But the same transcript later defers OpenBao and the whole secrets layer** (`:8743-8747`, `:9017-9019`):

> And that's it.
> No Iceberg.
> No ClickHouse.
> **No OpenBao initially.**
> No Kafka.
> ...

> Do **not** build yet: Neo4j, GraphRAG, DuckDB, Iceberg, Kafka, Redis, ClickHouse, complex multi-tenancy, distributed workers, **OpenBao**, elaborate IAM, zero-knowledge encryption, Kubernetes, custom observability infrastructure.
> Design interfaces so those can appear later, but don't install them.

So the transcript names OpenBao as the eventual secrets component *and* explicitly says not to install it initially — it should be designed-for, not built. This is directly relevant to the build-vs-reuse decision (§9.2): the transcript does not authorize standing up OpenBao now, and it frames the secrets component as a later layer behind a stable interface.

Note the transcript's "secrets" passages are about **brokerage of short-lived infrastructure credentials** (dynamic DB credentials, leases, 15-minute expiry). Issue #92 is about a **lightweight box of long-lived static items** (API keys, tokens, passwords, files/notes) with Octo-native metadata. The transcript does not itself discuss decoy keys or bi-temporal history.

## 4. The owning issues

### #92 — built-in secret storage (the owning issue)

Status line, verbatim:

> **Status:** backlog only. Don't implement without Alex's explicit go.

**Goal** (verbatim):

> Give octo proper, lightweight secret storage that replaces the self-hosted Infisical. Infisical was removed from gravebuster on 2026-10-03 because it used about 650 MB of RAM while idle and was never used.

**Scope** (verbatim):

> - **Secret boxes:** storage boxes that can hold several kinds of items, such as API keys, tokens, passwords and files or notes.
> - **Rotatable keys:** rotation with version history and a clean cutover.
> - **Fake/decoy keys:** canary or decoy entries that look real, so misuse can be detected.
> - **Bi-temporal keys:** both valid time (when a key is or was in effect) and record time (when octo learned or changed it), with queryable history.
> - **Lightweight:** low idle RAM and CPU, with no heavy always-on services.

**Done when** (verbatim):

> - [ ] The design for the box/item model, rotation, decoys and bi-temporal history is written up and approved by Alex.
> - [ ] Idle resource use is measured and clearly far below Infisical's (about 650 MB idle).
> - [ ] The first import works: the agent keys that the old Infisical runbook planned to hold are in octo, currently kept in plaintext env files on the host (paths redacted). They are `LITELLM_MASTER_KEY`, `LITELLM_EVAL_MASTER_KEY`, `CKFF_*`, `PLANE_API_KEY`, `TERMINUSDB_*` and `CONTEXT7_KEY_*`.
> - [ ] The plaintext env files are retired once consumers read from octo.

> Requested by Alex, relayed by PC Housekeeping, 2026-10-03.

Note: #92's "Done when" requires idle resource use **clearly far below ~650 MB**, and lists a concrete first-import set of static long-lived agent keys currently sitting in plaintext env files on gravebuster.

### #184 — agent grant (a workspace key and a long-running secret-store key)

Status line, verbatim:

> **Status:** goal only. Depends on #92. Do not build the secret box in this issue.

Body, verbatim:

> ## Goal
>
> A coding agent holds two long-running keys, and those two are the only credentials it needs until they expire.
>
> 1. **Workspace key.** Bound to the owner's primary workspace. Its allowances are the four Octo scopes the owner selects at mint. For every current Octo action, that is `read`, `write`, `files`, and `delete`. The role cap frozen at mint still applies, so file delete still needs an admin role on the key.
> 2. **Secret-store key.** Opens that same workspace's secret box from #92 and no other workspace. It can read a stored secret and it can put a new one in the box. It cannot call file, job, database, or retrieval routes. The workspace key cannot open the box.
>
> The agent uses the workspace key for Octo itself. When a task needs some other service, it uses the secret-store key to take that service's token from the box, or to file a token a person just handed it. After that filing, the same two keys cover the new service. No third key, and no copy of the token in a project `.env`.
>
> ## Enough until expiry
>
> The pair covers:
>
> - any Octo action the workspace key's allowances and role cap already allow
> - any outside service whose token is already in that workspace box, or which the agent files there with the secret-store key
>
> The pair does not cover:
>
> - an Octo action left off the workspace key
> - a secret that was never put in this workspace's box
> - either key after its expiry
>
> Expiry is chosen when a person mints the key. An API key cannot mint or renew a key, because confirm is human-only. When one of these two expires, a person mints the replacement and gives it to the agent.
>
> ## Boundary
>
> This issue records the grant. #92 records the box: items, rotation, decoys, and bi-temporal history. Retrieval, embeddings, and model calls are not part of either key.

#184 defines the intended **authorization model for agents** (workspace-scoped box, per-key scoping, human-only mint/renew, expiry chosen at mint) and explicitly separates it from the box's item model (#92).

## 5. Other issues touching secrets / credentials

From `gh issue list --state all --limit 200` (checked 2026-10-08):

- **#92** — built-in secret storage. OPEN. The owning issue (above).
- **#184** — agent grant: workspace key + secret-store key. OPEN. Depends on #92 (above).
- **#16** — "Credential onboarding — connect Google Drive and R2 without putting secrets in GitHub". CLOSED. Produced `docs/security/RUNTIME_SECRETS.md`. Its scope-control section is explicit: "Use ordinary platform/provider settings. No custom credential broker, mandatory fingerprint scanner, rotation ceremony, hidden holdout, or secret-management service."
- **#127** — "Slice 19 — Typed multi-tenant keys (analytics / agent-read / program-write)". CLOSED. Introduces key *classes*; the underlying `octo.api_keys` row stores `workspace_id`, `role`, and a `scopes` array (`read/write/files/delete/admin`), and `authorizeKeyMint` enforces that a token may only narrow its own authority. Relevant because #184's two-key grant builds on this key model.
- **#162** — "[OBSERVATION]: Agent recommended a self-hosted database for design-bakery and never used Octo's managed workspace-database layer". OPEN. Not about secrets directly, but the canonical instance of the project's "agents must use Octo, not stand up their own datastore" rule (see `docs/consuming-octo.md`). Bearing: an agent that "solves" secret storage by hosting its own service would repeat this pattern.
- **#135 / #142 / #138** — the security-audit fix issues (ISS-1/2, ISS-3/4/6/7, ISS-5). CLOSED. See §6.
- **#14** — "Slice 12 — Scale deliberately: multiple workers, failure drills, observability, then multiple API nodes". OPEN. Not a secrets issue; listed only to show the open-slice backlog contains nothing secrets-related.
- **#187** — "Hosting convention: move the gravebuster deploy to `/srv/octo-database` and decide the tailnet `:5432` exposure (proposal)". OPEN. Hosting/topology; relevant only because the secret drop runs on gravebuster and binds a tailnet port.

No other issue in the list concerns secret storage.

## 6. Security-audit lessons relevant to credential design

From `docs/security/2026-10-05-deep-security-audit-issue-log.md` (whole-system audit, read-only; ISS-1..ISS-7 all FIXED). Only the parts bearing on credentials:

- **ISS-1 (HIGH, FIXED): the primary key was a bearer secret.** `authenticateRequest` accepted any Bearer token matching a UUID as a principal id with no secret, expiry, or revocation check (`docs/security/2026-10-05-deep-security-audit-issue-log.md:11-31`). The fix was to issue a signed, expiring, revocable session token instead (`:31`).
- **The credential-design lesson** (`:204`): "the worst chain (ISS-1) is a credential-*design* flaw — 'the primary key is a bearer secret.' No model or property test prevents that; it is a design-review catch."
- **Promotion-forbidding invariant** (`:200`): ISS-1..ISS-4 were identity-*promotion* mistakes — share→principal, payload→object, id→credential. The high-yield property form is: *no unauthenticated or lower-privilege input may yield an `AuthContext` (or a resolved object key) with more authority than its provenance.*
- **RLS fence is sound** (`:161`, `:198`): all 20 tenant tables are covered by the `slice14` RESTRICTIVE `tenant_scope_fence`; no SQL injection found. This is the tenant-isolation backstop a secret store would inherit.

The relevant carry-over for a secret store: a stored secret's *identifier* must not itself be a usable credential, and a lower-privilege principal (e.g. a read-only agent, or a tailnet peer) must not be able to promote its access into a broader credential.

## 7. Productization slices — there is no secrets slice

`docs/productization/SLICE_MAP.md:7-18` lists the accepted slices 0–9. None concerns secret storage:

| Order | Slice | Main dependency | Robustness |
|---|---|---|---|
| 0 | Complete runtime/bootstrap prerequisites and make the online test deployment usable | Existing deployment; #75 baseline train sync and #78 local test bootstrap are merged; #76 tracks the next upstream train | Level 2 for durability claims |
| 1 | Discover the operations a caller can use in a selected workspace, then invoke an advertised operation | Existing auth, API and PostgreSQL | Level 2: live authority and deployed API |
| 2 | Complete the existing workspace file lifecycle: find, retrieve, archive, restore and share intended files | Slice 1; existing gallery, storage and jobs | Level 2: durable bytes and transitions |
| 3 | Complete the same workspace/file jobs through the TypeScript SDK, CLI and MCP adapter | Slice 1; stabilized operations from Slice 2 | Level 2: client/server equivalence |
| 4 | Select a frontend delivery approach through a bounded bakeoff | Stable API plus Slice 2 fixtures | Level 1: evaluated prototype |
| 5 | Deliver the selected workspace shell with overview, gallery, keys and operations | Slice 4 and useful flows from Slices 1–3 | Level 2: real browser jobs |
| 6 | Recover one owner-declared set of important user/agent files on a fresh machine | Slice 2; recovery UI from Slice 5 | Level 2: recovery is the product claim |
| 7 | Answer one accepted historical workspace question with Parquet and DuckDB | API foundation and issue #13 | Level 2: durable dataset and result metadata |
| 8 | Let an agent propose one supported change, then let a human authorize that exact proposal | Slices 1–5; one supported action | Level 2: durable proposal and execution state |
| 9 | Rebuild and query an optional graph projection for a graph-enabled workspace | Existing epistemic model and issue #12 | Level 2: reconstruction and freshness |

Slice 5 mentions a "keys" surface, but that is the existing API-key/gallery shell, not secret storage. There is **no accepted packet, no locked success condition, and no slice number** for secrets. Any planning here is pre-slice.

## 8. Existing temporary infrastructure: the ephemeral secret drop

This was built and is running on gravebuster as a **temporary handoff mechanism** while a permanent design is decided. It is documented as existing infrastructure, not as a proposed design, and its existence creates no obligation to keep or extend it.

- **Service:** a single-file Python 3 stdlib HTTP service at `~/apps/secret-drop/secret_drop.py` on gravebuster, run as a systemd **user** unit `secret-drop.service`.
- **Two listeners, split as the authorization boundary:**
  - **Operator port** on `127.0.0.1:8787` — routes `/new` (mints a token) and `/take/<token>` (reads-and-destroys).
  - **Public port** bound directly on the tailnet interface `<redacted tailnet address>:8098` — route `/d/<token>` only (paste form + submit).
  - Operator routes return 404 on the public port.
- **Semantics:** in-memory only, nothing on disk, one-time read (destroyed on take), 60-minute TTL, no path logging (tokens never reach logs). Secrets are **not persisted** — this is transfer, not storage.
- **Why it exists:** to hand credentials to an agent without pasting them into a chat transcript.
- **Known limitations (recorded honestly):** no persistence; no retrieval-after-read; no revocation; no audit; no per-principal scoping. Any tailnet peer can reach the public port — tailnet membership is the only boundary (the tailnet has ~25 peers, including shared/offline devices, per this session). The operator surface is host-local only.

The drop solves **transfer**. It does not implement any of #92's box, rotation, decoy, or bi-temporal features, and it does not implement #184's scoping.

---

## 9. Open decisions to frame

These are questions for the owner and planning agent. They are **not** decided here, and no acceptance criteria are proposed.

### 9.1 Transfer vs. storage

The drop (#8) solves transfer of a secret to an agent. Persistent storage (#92) is a different component: it needs retention, retrieval-after-read, revocation, per-principal scoping, and (per the transcript and audit) possibly audit. The two should not be conflated. Question: is the drop sufficient for now, with persistent storage deferred, or is storage the actual near-term need?

### 9.2 Build vs. reuse (OpenBao vs. bespoke)

The transcript names **OpenBao** for secrets (`:7876`, `:8263`, `:8398-8399`) and describes leases, dynamic credentials, rotation, and 15-minute expiry (`:8245-8296`) — but it also says "**No OpenBao initially**" (`:8747`) and lists OpenBao among things to "**not** build yet" (`:9017`), with "Design interfaces so those can appear later, but don't install them" (`:9019`). So the transcript itself does not authorize standing up OpenBao now.

Building a bespoke store risks exactly the anti-goal quoted at `:8446` ("without turning your own API server into a badly reimplemented ... secret manager"), and `AGENTS.md:16` says reuse before build. Counterweights to weigh factually: (a) #92's feature set includes decoy/canary keys and bi-temporal valid-time + record-time history, which the transcript's OpenBao description does not mention (whether OpenBao covers them is not established in these sources); and (b) #92's "Done when" requires idle RAM **clearly far below ~650 MB**, so whether any reused always-on backend can meet that bar is an open question, not a settled one. Question: which components of #92 does an existing OSS secret manager satisfy, and which (if any) require Octo-native work — and is building anything now consistent with the transcript's "no OpenBao initially"?

### 9.3 Authorization model

The transcript's default is agents get `secrets.read no` (`:7779`) and capabilities are workspace-scoped (`:7774`). #184 defines a workspace-scoped secret-store key that opens only that workspace's box and cannot call file/job/database/retrieval routes. By contrast, a "any tailnet peer can read any secret" model (the drop's public port) makes tailnet membership the only boundary — and the tailnet has ~25 peers including shared/offline devices. Question: what is the principal model for stored secrets, and is tailnet membership ever an acceptable authorization boundary for them?

### 9.4 The "in Octo vs. OpenBao broker" question

Issue #92 says the store is *in Octo*. The transcript says the platform *brokers* to a secret backend (OpenBao) rather than storing secrets itself (`:8345-8446`), while also deferring OpenBao entirely at first (`:8747`, `:9017`). This is stated here neutrally, as a scoping question, not a contradiction:

- The transcript's OpenBao passages are about **brokerage of short-lived infrastructure credentials** (dynamic DB credentials, leases, 15-minute expiry).
- #92 is about a **lightweight box of long-lived static items** (API keys, tokens, passwords, files/notes) with Octo-native metadata (decoys, bi-temporal history).
- Per `AGENTS.md:9`, owner direction outranks agent-authored planning prose: #92 is the owner's issue, the transcript is advisory input. If they truly conflict, #92 wins.

Question: are these two layers (a lightweight static-item box in Octo, and brokerage of short-lived infra credentials) actually distinct components, or is the owner expecting one?

### 9.5 The "agent requests, owner fills in" flow

The transcript says "Agents should be able to request access. They should not own access policy." (`:8294-8296`), and #184 has the agent "file a token a person just handed it" and human-only mint/renew. This is new UX (an agent asks for a credential; a human fulfills it) and it depends on the authorization model in 9.3. Question: does this flow exist as a requirement, and if so where does the human fulfill it (Octo UI, the drop, something else)?

---

## Open questions for the owner

1. **Transfer or storage first?** Is the existing ephemeral drop enough for the current need, or is persistent secret storage (#92) the near-term goal? (9.1)
2. **Reuse OpenBao, or build the box in Octo?** The transcript names OpenBao but says "No OpenBao initially" and lists it under "Do not build yet" (`:8747`, `:9017`). #92's decoy + bi-temporal features are not part of the transcript's OpenBao description, and #92's "<650 MB idle" bar raises a footprint question for any reused backend. Which matters more — reuse, the specific feature set, or deferring the whole layer? (9.2)
3. **What authorizes a stored secret?** Per-workspace box keys as in #184 and `secrets.read no` by default as in the transcript, or is tailnet membership an acceptable boundary as in the drop? (9.3)
4. **In Octo or brokered to OpenBao?** Are the transcript's short-lived credential brokerage and #92's long-lived item box the same component or two? (9.4)
5. **Is the "agent requests, owner fills in" flow in scope**, and if so where does the human fulfill the request? (9.5)
