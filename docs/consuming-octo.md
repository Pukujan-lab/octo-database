# Consuming Octo — Octo is your data layer

**Audience:** coding agents and humans working in a project that Octo serves
(design-bakery and any future adopter).

If a project is served by Octo, its durable data lives in Octo. You do not run the
database; Octo provisions one for the project, and you reach it either through Octo's
SQL surface or — when you need a direct connection — with its own connection string.

---

## You consume Octo; you do not change it

**Octo's repository is read-only to its adopters.** Consuming Octo (via its API, MCP, or
SQL surfaces) grants **no write access to this repository in any form** — no pull
requests, no branches, no file edits, not even "documentation fixes", and not even to
make Octo "work for you". Octo is the platform; your project is a client of it.

If Octo lacks something you need:

1. **Propose it — don't patch it.** File an issue under the OIO observational-issue
   protocol (`[OBSERVATION]` template). It is a **non-binding proposal**, not a mandate.
2. **Human consent gates everything.** A proposal becomes work only if the **owner**
   accepts it, and the change is made by an agent the owner directs — never by the
   adopter. Do not open a PR against Octo, with or without verbal approval.
3. **Work around it in your own project, or wait.** Build what you need against Octo's
   public surfaces in your own repo; adapting Octo itself is not something an adopter
   does.

See `AGENTS.md` → "Adopters do not modify this repository" for the operative rule.

---

## The rule

Do **not** provision, scaffold, or recommend a database for an Octo-served project.
That includes:

- a dedicated Postgres container of your own (a "project-db" service on its own volume);
- a managed Postgres elsewhere (Railway, a separate Supabase project, RDS, …);
- a database "for independence" — a second datastore so the project is not "tied to" Octo;
- a database co-located on Octo's own host as a peer to Octo's Postgres.

All four are the same mistake. You are not the project's database operator — Octo is.

Instead: **provision the workspace database through Octo, then reach it either with
your Octo API key (run SQL through Octo) or with an ordinary Postgres client.** That is
the whole job.

## Why

Octo exists so data does not fragment across per-project datastores. "Host my own
database" is a default instinct for most coding agents, and for an Octo project it is
the exact anti-pattern Octo was built to prevent. Recommending it — even as one option
among several — erodes the single-data-layer guarantee one "recommended option" at a
time. This is not hypothetical: see incident **#162**.

## The exception (narrow)

Skip Octo's managed database only when you can **demonstrate a concrete, specific
incompatibility** with Octo's provisioned Postgres — with evidence, not a preference.

These are **not** incompatibilities:

- "the project should be independent of Octo";
- "I want control over the database";
- "it is a different engine / version / extension";
- "it is simpler to run my own";
- "the project already had one before Octo".

Octo's provisioned database is a **real, independently connectable PostgreSQL
database** with its own scoped role — not a shared table, not a proxy, not a
control-plane schema. So there is no isolation or autonomy argument for a second one.

If you believe you have a genuine incompatibility, **stop and surface it to the owner**
before building anything. Do not quietly stand up a second datastore as the "safe"
option.

## Getting your key (a human does this once)

You need an Octo API key before you can do any of the below. **Creating a workspace
and minting a key are human-stamped** — a human browser session plus the account's
confirmation secret (and a TOTP code when MFA is enrolled). **An API key can never
create a workspace or mint a key** (`403`, by design — the same gate that stops a
blind agent deleting a workspace).

So the bootstrap is a human step, done once per project:

1. The human opens the Octo dashboard, creates (or already has) the project's
   workspace, and mints a **workspace-scoped key** (`octo_live_ws_`) for it, with the
   scopes the project needs — `read`, `write`, `files`, and `delete` for a project
   that runs `octo-sync` (delete is required for `push` to replace a record).
2. The human puts that key in the project's `.env` (the project's normal secret
   mechanism).
3. You use that key for everything below.

If you do not have a key, **stop and ask the human** — that is the intended path, not
a broken system. Do not provision a database of your own to work around it.

## How to consume Octo's database

There are two ways in, and you can use either or both:

- **Through Octo (no connection string).** Run SQL with just your Octo API key —
  `POST /api/workspaces/<id>/query` or the MCP tool `query_workspace_database`. Nothing
  to store, nothing to leak, works from anywhere the Octo API is reachable.
- **Directly (a Postgres client).** The workspace already has a database; store its
  connection string, then connect with `pg`, Prisma, Drizzle, `psql`, whatever the project
  already uses.

### Through Octo — the SQL surface (Slice 21)

```
POST /api/workspaces/<id>/query      Authorization: Bearer <octo_live_...>
{ "sql": "select * from items where label = $1", "params": ["alpha"], "rowLimit": 100 }
```

- **Read scope** runs in a read-only transaction: `SELECT` works, writes are refused by
  the database. **Write scope** is required to mutate.
- A **workspace-scoped key works here** for its own workspace (unlike provisioning) —
  this is exactly what a scoped key is for. The workspace binding is still enforced.
- The server authenticates as the workspace's own role. The credential never crosses the
  wire, and the SQL executes with no more authority than the workspace already has.
- A multi-statement request (a whole migration) is allowed for a write caller with no
  parameters; a parameterized or read-only request is a single statement.

### Directly — connect to the workspace's database

1. **The database already exists.** A workspace created through
   `POST /api/workspaces` (or the MCP tool `create_workspace`) is auto-provisioned with
   its own database at creation; the response reports `databaseProvisioned: true`. Only a
   workspace that predates this — or one created while `OCTO_ADMIN_URL` was unset — needs
   the explicit provision step: MCP tool `provision_database`, or
   `POST /api/workspaces/<id>/database`. That route requires an account-wide key with the
   `write` scope (a workspace-scoped key cannot provision) and returns
   `{ dbName, roleName, connectionString }`.
2. **Get the connection string, if you need it.** The explicit provision route returns it
   once. A workspace that was auto-provisioned at creation is fully usable through the SQL
   surface with no string at all; a direct string is only needed for a client that speaks
   Postgres itself, and it is shown **exactly once**, so store it immediately in the
   project's normal secret/env mechanism.
3. **Connect with any Postgres client** — `pg`, PostgREST, Prisma, Drizzle, `psql`,
   whatever the project already uses. The role owns only its own database and reaches
   no Octo control-plane data.
4. **pgvector is already enabled.** Create your own tables and schema freely.
5. **Lifecycle.** Deleting the workspace drops the database and its role.

### The credential

The connection string is the workspace database's **own** credential, scoped to that one
database. It is the single deliberate exception to "agent tokens never expose
infrastructure credentials." Do not reuse it elsewhere and do not treat it as an Octo
control-plane token. If you would rather never hold it at all, use the SQL surface
above — it needs no connection string.

## Historical analytics — Parquet and DuckDB (Slice 7)

Analytical questions ("how many jobs failed, by type and month") do not belong in the
transactional workspace database. Octo answers them over **immutable Parquet dataset
versions** with **DuckDB**, in-process in the existing job worker. There is no separate
analytics service and nothing to deploy.

Four rules define the surface:

- **The caller never supplies SQL and never supplies an object key.** You name a dataset,
  a query spec, and ids. The server builds the statement and derives every storage key
  from the authenticated workspace.
- **A registration is immutable.** A re-export is a new version (`v1`, `v2`, …); nothing
  is mutated or overwritten.
- **Query execution is a job.** Submission returns a job id; poll it, then fetch the
  derived result artifact.
- **Everything is workspace-fenced.** A dataset version, job, or result belonging to
  another workspace answers `404`, not `403`.

### Endpoints

| Call | Method and path | Scope | What it does |
| --- | --- | --- | --- |
| `datasets.register` | `POST /api/workspaces/<id>/datasets` | write | Register one immutable Parquet dataset version. |
| `analytics.query` | `POST /api/workspaces/<id>/analytics/queries` | read | Submit one named query over a version. |
| `analytics.query_status` | `GET /api/workspaces/<id>/analytics/queries/<jobId>` | read | Read the job's state and, once completed, its result. |
| `analytics.result` | `GET /api/workspaces/<id>/analytics/results/<resultId>` | read | Result metadata plus a short-lived download URL. |

All four require **member** role in the workspace. The named key class `analytics` is
read-only, so it can query but cannot register — registration needs a key with the
`write` scope.

### 1. Register a version

```json
POST /api/workspaces/<id>/datasets
{
  "dataset": "job-history",
  "name": "Job history export",
  "format": "parquet",
  "schema": [
    { "name": "job_type", "type": "TEXT" },
    { "name": "state", "type": "TEXT" },
    { "name": "created_at", "type": "TIMESTAMP" }
  ],
  "provenance": { "source": "octo.jobs", "exportedAt": "2026-10-19T00:00:00Z" },
  "watermark": "2026-10-18T23:59:59Z",
  "parts": [
    { "partition": "2026-09-30", "dataBase64": "<parquet bytes>" }
  ]
}
```

`parts[].partition` is a real `YYYY-MM-DD` date; `dataBase64` is the Parquet file.
The server inspects every footer, rejects a schema that differs from the declaration
(`SCHEMA_MISMATCH`), sums the row counts, assigns the next version under a lock, and
writes the bytes to server-derived keys. `dataset` is a lowercase slug (`[a-z0-9-]`)
that stays stable across versions.

Response: `201 { datasetVersion, created: true }` for a new version, `200 … created:
false` when `idempotencyKey` matches an existing registration, `409
DATASET_VERSION_CONFLICT` on a concurrent collision (retry).

### 2. Submit a query

```json
POST /api/workspaces/<id>/analytics/queries
{ "datasetVersionId": "<uuid>", "querySpec": "job-failures-by-type-month@1" }
```

Available spec — `job-failures-by-type-month@1`:

- **Inputs:** `job_type TEXT`, `state TEXT`, `created_at TIMESTAMP`.
- **Output:** `job_type`, `month` (UTC month start), `failure_count` (BIGINT).
- **Meaning:** count failed jobs per job type per month, ordered by type then month.

Response: `201 { job: { id, jobType: "analytics_query", state, idempotencyKey }, created }`.
The default idempotency key is `analytics:<datasetVersionId>:<querySpec>`, so submitting
the same query twice returns the same job; pass your own `idempotencyKey` to run it again.

### 3. Poll, then fetch the result

```
GET /api/workspaces/<id>/analytics/queries/<jobId>
→ { jobId, state, jobType, errorCode, errorSummary, resultId, result }
```

`state` moves `queued → running → completed | failed`. The worker drains the queue on its
own interval; `POST /api/jobs/run?workspaceId=<id>` (write scope) runs one pass
immediately. On failure, `errorCode` is one of `DATASET_VERSION_NOT_FOUND`,
`PARQUET_MISSING`, `PARQUET_CORRUPT`, `SCHEMA_MISMATCH`, `QUERY_TIMEOUT`,
`QUERY_CANCELLED`, `RESULT_REGISTRATION_FAILED`, `ANALYTICS_NOT_CONFIGURED`, or
`INVALID_PAYLOAD`.

```
GET /api/workspaces/<id>/analytics/results/<resultId>
→ { result: { id, datasetVersionId, querySpec, objectKey, rowCount,
              contentHash, engineVersion, createdAt },
    downloadUrl, expiresInSeconds }
```

`downloadUrl` is a presigned R2 URL in production and the authenticated content route
(`/api/workspaces/<id>/analytics/results/<resultId>/content`) on a local storage
backend. The artifact is Parquet; read it with DuckDB, pandas, Polars, or pyarrow.
`contentHash` is the SHA-256 of the bytes, so a re-run can be compared for determinism.

### Through MCP

`register_dataset`, `query_dataset`, `get_analytics_query_status`, `get_analytics_result`
— same arguments as the HTTP calls, with the parts supplied as `{ partition, dataBase64 }`.

### Availability

If the DuckDB native module or the object store is unavailable, `/health` reports
`analytics: { configured: false, … }` and the routes answer `503
ANALYTICS_NOT_CONFIGURED`. The rest of Octo keeps working; analytics is an optional
surface, not a boot dependency.

## The vault: three token families, and what each one can see

Octo's vault holds the owner's real vendor credentials. Three different tokens touch
it, and they are **not interchangeable**. Name the one you hold by its prefix.

| Prefix | Name | Who holds it | What it can do |
| --- | --- | --- | --- |
| `octo_live_acc_…` / `octo_live_ws_…` | API key | Agent | Workspaces and SQL. **Cannot open the vault** — `GET /api/vault/open` answers `401`, other `/api/vault/*` routes `403`. |
| `octo_vault_…` | Vault grant | Agent | The cabinet **inventory**: labels, descriptions, urls, `hasSecret`, routes. Never a stored value. Mints working keys. |
| `octo_tmp_…` | Working key (lease) | Agent | One stored item, relay only. **Never sees the vendor secret** and cannot open the cabinet. |

### A grant is an inventory, not a reader

`GET /api/vault/open` with a grant tells you **that** a key exists and how to reach
it. It does not decrypt anything. There is no call, with any grant, that returns a
stored `secret` or `notes` value — the only way to spend a credential is a working
key on a relay route, where Octo injects it server-side.

That is what makes one grant safe to hand an agent: it can discover all of the
owner's keys, and it still cannot read one. The owner-only item, route, and grant
endpoints answer `403` to a grant — that is a scope limit, not an expired session.

## Using a vendor credential without holding it

A stored vendor key can be used by an agent that never sees it. The owner stores the
real key once in the vault and gives the agent a **vault grant** (`octo_vault_…`). The
grant lets the agent find the item and ask for a working key scoped to it, which
expires on its own and can be revoked on its own.

### 1. Ask for a working key

```bash
curl -s -X POST https://octo.example/api/vault/open/lease \
  -H "Authorization: Bearer $OCTO_VAULT_GRANT" \
  -H 'Content-Type: application/json' \
  -d '{"label": "Fish Audio", "expiresInDays": 15}'
```

`label` must match a stored item in the grant's cabinet; `itemId` works too.
`expiresInDays` defaults to 15 and accepts 1–30. Asking again for the same item
rotates the previous working key out.

A working key is **free-form**: it is not pinned to one base URL. The lease stores
only *how* to inject the secret. That recipe comes from, in order, a `baseUrl` and
scheme you pass at lease time, an existing dashboard route on the item, or the
item's own `url` with a bearer header. An item with none of those still mints — you
just name the target on every request.

```bash
curl -s -X POST https://octo.example/api/vault/open/lease \
  -H "Authorization: Bearer $OCTO_VAULT_GRANT" \
  -H 'Content-Type: application/json' \
  -d '{"itemId": "…", "baseUrl": "https://api.vendor.example/v1", "authScheme": "x-api-key", "authHeader": "X-Api-Key"}'
```

`authScheme` defaults to `bearer`; `x-api-key` and `query` also need `authHeader`,
`basic` can take `basicUsername`, and `body_json` and `path` need `bodyField`.

The response carries the working key and the proxy entry point:

```json
{
  "lease": { "id": "…", "itemLabel": "Fish Audio", "prefix": "octo_tmp_…", "expiresAt": "…" },
  "rawSecret": "octo_tmp_…",
  "proxy": {
    "url": "https://octo.example/api/vault/proxy",
    "targetHeader": "x-octo-target",
    "defaultTarget": "https://api.vendor.example/v1"
  },
  "routes": []
}
```

The raw key is shown once. `routes` lists any dashboard routes the item already
had; a lease no longer needs one.

### 2. Send it wherever the vendor is

Name the full upstream URL in `x-octo-target` (or `?target=`, or as the path after
`/api/vault/proxy`). Any `http(s)` URL works, independent of the item's url:

```bash
curl -s https://octo.example/api/vault/proxy \
  -H "Authorization: Bearer octo_tmp_…" \
  -H "x-octo-target: https://api.vendor.example/v1/tts" \
  -d '{"text": "hello"}'
```

The path form is convenient when a client only lets you set a base URL:

```bash
curl -s "https://octo.example/api/vault/proxy/https://api.vendor.example/v1/tts" \
  -H "Authorization: Bearer octo_tmp_…"
```

A relative path resolves against `defaultTarget`, so `/api/vault/proxy/v1/tts`
reaches `https://api.vendor.example/v1/tts`. With no target and no
`defaultTarget`, the proxy answers `400 TARGET_REQUIRED`.

The proxy resolves the working key, injects the stored secret using the lease's auth
scheme, forwards the request, and streams the vendor's response back. The working key
is stripped from every position the scheme does not use, so it never reaches the
vendor. The path and query are forwarded unchanged.

The proxy accepts the working key in any of the usual positions — `Authorization:
Bearer`, `Basic` (either half), `x-api-key`, the path, or a query parameter — and
refuses two *different* keys in two positions. The scheme decides how the stored secret
is injected upstream:

| Auth scheme | Put the working key where the vendor expects it |
| --- | --- |
| `bearer` | `Authorization: Bearer octo_tmp_…` |
| `x-api-key` | the configured header, e.g. `x-api-key: octo_tmp_…` |
| `basic` | `Authorization: Basic base64(user:octo_tmp_…)` |
| `query` | the configured query parameter |
| `body_json` | the configured JSON body field, e.g. `{"api_key": "octo_tmp_…"}` |
| `path` | in the path where the vendor puts the token, e.g. Telegram `/bot<octo_tmp_…>/getMe` |

A dashboard route keeps working through its pinned relay URL,
`ANY /api/vault/relay/<routeKey>/…`, which forwards the caller's path below the
route's base URL. Use the proxy when the agent needs to choose the upstream.

### 3. Renew, inspect, revoke

```bash
# extend the working key
curl -s -X POST https://octo.example/api/vault/lease/renew \
  -H "Authorization: Bearer octo_tmp_…" -H 'Content-Type: application/json' \
  -d '{"expiresInDays": 15}'

# what is this key for?
curl -s https://octo.example/api/vault/lease/info -H "Authorization: Bearer octo_tmp_…"
```

The owner lists and revokes working keys from the vault dashboard
(`GET /api/vault/leases`, `DELETE /api/vault/leases/<id>`). A revoked or expired key
answers `401`.

### What a working key cannot do

It is not a session, a grant, or an API key. It cannot open the cabinet, list vault
items, list grants, create workspaces, or call any path outside
`/api/vault/proxy`, `/api/vault/relay/<routeKey>`, `/api/vault/lease/renew`, and
`/api/vault/lease/info`. Every other Octo path answers `401`.

That fence is the point: a working key is the only vault token an agent should hold.

## Vault endpoints (exact paths)

There is no separate "vault service" host or subdomain. The vault is part of the Octo
API, under `/api/vault/`. If a token returns `401` on `/api/files`, `/api/shares`, or
`/api/workspaces`, that is expected — those are not vault routes.

| Call | Token | Purpose |
| --- | --- | --- |
| `GET /api/vault/open` | grant | Read the cabinet **inventory**. Never returns a stored secret. |
| `POST /api/vault/open/lease` | grant | Mint a working key for one item. |
| `POST /api/vault/lease/renew` | working key | Extend a working key. |
| `GET /api/vault/lease/info` | working key | Describe a working key. |
| `ANY /api/vault/proxy[/<target>]` | working key | Call any vendor URL through Octo. |
| `ANY /api/vault/relay/<routeKey>/…` | working key | Call a dashboard route's vendor through Octo. |
| `GET /api/vault/grants`, `DELETE /api/vault/grants/<id>` | session | Owner lists and revokes grants. |
| `GET /api/vault/leases`, `DELETE /api/vault/leases/<id>` | session | Owner lists and revokes working keys. |

A token that is valid for one row of that table is not valid for another. In
particular, a grant does **not** authenticate `/api/workspaces`, `/api/files`, or the
SQL surface, and an API key does **not** authenticate `/api/vault/open`.

## Discover it

- `GET /api/capabilities` → `workspaces.create`, `workspaces.query`,
  `workspaces.provision_database`, `datasets.register`, `analytics.query`,
  `analytics.query_status`, `analytics.result`
- Analytics: `POST /api/workspaces/<id>/datasets`,
  `POST /api/workspaces/<id>/analytics/queries`,
  `GET /api/workspaces/<id>/analytics/queries/<jobId>`,
  `GET /api/workspaces/<id>/analytics/results/<resultId>`
- Vault: `GET /api/vault/open`, `POST /api/vault/open/lease`,
  `POST /api/vault/lease/renew`, `GET /api/vault/lease/info`,
  `ANY /api/vault/proxy[/<target>]`, `ANY /api/vault/relay/<routeKey>/…`
- MCP tools `create_workspace`, `query_workspace_database`, `provision_database`,
  `register_dataset`, `query_dataset`, `get_analytics_query_status`,
  `get_analytics_result`
- Octo README, "Slice 21"; `docs/self-hosting.md`

## Adopting an existing project that already runs its own datastore

If a project already speaks to a database directly (for example PostgREST via
`@supabase/supabase-js`), the adoption path is to **re-point its data path at the Octo
workspace database** — not to keep the old datastore alongside Octo. Provision the
workspace database, point the project's client at the returned connection string, and
migrate its schema/data into it. Surface the migration plan to the owner.

---

## Boot block for an adopter's `AGENTS.md`

Copy this into the adopting repo's `AGENTS.md` (or `CLAUDE.md`) so a fresh agent session
sees it without having to read Octo's repo first:

```markdown
## Data layer — Octo

This project's durable data lives in Octo, not in a database you run. Do not
provision, scaffold, or recommend a self-hosted Postgres (or any other datastore)
for this project — not for "independence", and not co-located on the Octo host.

**Your key is minted by a human, once.** An API key can never create a workspace or
mint a key (human-stamped by design). If you have no `OCTO_API_KEY` in the project
`.env`, stop and ask the human to create the workspace and mint a workspace-scoped
key in the Octo dashboard — do not stand up your own database to work around it.

Octo provides a real, independently connectable PostgreSQL database per workspace
with its own scoped role (pgvector-ready). Reach it either way:

- **Through Octo (no connection string):** run SQL with your Octo API key —
  MCP `query_workspace_database` | HTTP `POST /api/workspaces/<id>/query`.
  Read scope is read-only; write scope mutates.
- **Directly:** the workspace already has its own database; connect with its connection
  string and store it as a secret. A workspace that still lacks one — created before
  auto-provision, or while `OCTO_ADMIN_URL` was unset — gets it from
  `provision_database` | `POST /api/workspaces/<id>/database`, returned once.

**Historical analytics lives in Octo too.** For analytical questions over large
history, register immutable Parquet dataset versions and run a named query spec with
DuckDB — do not add a warehouse or a second analytical database. MCP
`register_dataset` → `query_dataset` → `get_analytics_query_status` →
`get_analytics_result`; HTTP under `/api/workspaces/<id>/datasets` and
`/api/workspaces/<id>/analytics/…`. You never supply SQL or object keys.

Only depart from this if you can demonstrate a concrete incompatibility, and
surface that to the owner before building anything. See Octo's
`docs/consuming-octo.md` (repo: octo-database) and incident #162.

**Vault tokens are not interchangeable.** Name the token by its prefix before using
it. `octo_live_…` is an API key: it cannot open the vault. `octo_vault_…` is a
**vault grant**: `GET /api/vault/open` lists every item's label, description, url,
and `hasSecret` — the inventory, never a stored value. `octo_tmp_…` is a **working
key**: one stored item, relay-only, never reveals the vendor secret. To use a vendor
key, list the cabinet with the grant, mint a working key for the item you need
(`POST /api/vault/open/lease`), then send requests to `/api/vault/proxy` with the
working key and the vendor URL in `x-octo-target`. The key is not pinned to a base
URL; any `http(s)` target works.
The vault lives under `/api/vault/` on the same Octo host — there is no separate
vault subdomain, and `401` on `/api/workspaces` or `/api/files` with a vault token is
expected, not a sign the vault is missing.

**Octo's repo is read-only to you.** You consume Octo; you do not change it — no
pull requests, branches, or file edits against `octo-database`, not even to make
Octo "work for you". Need something Octo lacks? File an OIO `[OBSERVATION]`
proposal (non-binding) and let the owner decide; build workarounds in *this*
project against Octo's public surfaces.
```
