# Octo Architecture — Repository Shape

Octo is a **modular monolith organized by feature (vertical slice)**, with a light
MVC-style layering inside each slice. One deployable API, one obvious place for
each kind of thing.

This document states the shape and how it is enforced. It is the authority for
"where does new code go". `AGENTS.md` carries the short version agents read first.

## Deployables (unchanged by this shape)

Two containers, per `deploy/gravebuster/docker-compose.yml`:

- **`octo-web`** — Caddy serving the built Vite SPA (`frontend/` → `dist/`).
- **`octo-api`** — Node running `tsx src/server/index.ts` (`Dockerfile.api`).

Collapsing them into one process is *not* part of this shape. `src/server/static-file.ts`
already lets the API serve the built frontend, so the option stays open, but it is a
separate decision.

## The tree

```
src/
  routes/       HTTP slices — one file per route family, thin controllers
  server/       composition root, request plumbing, per-domain SQL stores
    index.ts      the composition root: builds the runtime, owns the dispatch loop
    db.ts         the database barrel — the one sanctioned import surface for SQL
    db-core.ts    pools, request identity, query/queryWithService/withTransaction
    db/           per-domain stores (identity, workspaces, files, keys, shares, jobs, rag, epistemic, graph)
    http.ts       request/response helpers (sendJson, readBody, ...)
    auth-context.ts  AuthContext, authenticateRequest, scope checks
    ops.ts, confirm.ts, queue.ts, google-auth.ts, present.ts, auto-provision.ts
    oauth.ts, mcp-http.ts, provisioning.ts, query.ts, static-file.ts
  api/          domain services — capabilities, keys
  auth/         domain services — authorization, session, workspace-service, confirm-challenge
  media/        domain services — gallery, shares, thumbnails, media tokens, classifier
  storage/      domain services — object store, R2, Google Drive, file/archive/publish
  jobs/         domain services — job service, worker
  rag/          domain services — embeddings, pipeline
  graph/        domain services — FalkorDB client, projector
  sync/ backup/ triage/ mcp/ qa/   domain services
  lib/          pure helpers, no I/O to Octo state (leaf)
  types/        shared types (leaf)
frontend/       its own Vite + React tree; has its own eslint config
```

## The layer rule

```
routes ──▶ services/stores ──▶ db-core ──▶ lib ──▶ types
   │              │
   └──────────────┴──▶ lib, types (any layer may use the leaves)
```

One direction only. A lower layer never imports a higher one.

- **routes** — match a request, authenticate, call a service or store, shape the
  response. No business logic, no SQL.
- **services** (`src/<domain>/`) — business logic for a slice. Depend on `lib`,
  `types`, and the `src/server/db` barrel. Never on `src/routes/`.
- **stores** (`src/server/db/<domain>.ts`) — SQL only. Depend on `db-core`, sibling
  stores, `lib`, `types`. Never on routing, request identity, or response shaping.
- **db-core** — the pools, the single request-identity `AsyncLocalStorage`, and the
  query/transaction primitives. The only module that may import `pg` or `async_hooks`.
- **lib**, **types** — leaves. No imports from any domain, `server`, or `routes`.

## Where does new code go

| You are adding | Put it in | Check |
|---|---|---|
| A new HTTP endpoint | `src/routes/<family>.ts` (new file → one line in the `ROUTES` array) | `npm run lint:imports` |
| Business logic for a slice | `src/<domain>/<name>-service.ts` | same |
| SQL for a slice | `src/server/db/<domain>.ts`, exported through the `src/server/db.ts` barrel | same |
| A shared request/response helper | `src/server/http.ts` | same |
| Auth/scope plumbing | `src/server/auth-context.ts` | same |
| A pure helper with no I/O | `src/lib/` | same |
| A shared type | `src/types/` | same |
| A React component | `frontend/src/components/{ui,portal,access}/` | `frontend/eslint.config.js` |
| A page/view | `frontend/src/pages/` or `frontend/src/views/` | same |

## Enforcement

The shape is **machine-checked, not advisory**. `npm run lint:imports` runs
`dependency-cruiser` against `.dependency-cruiser.cjs` and runs inside the required
`gates` check, so a boundary violation fails CI.

Run it before opening a PR:

```bash
npm run lint:imports
```

A violation prints the offending `from → to` edge and the rule name; the rule's
`comment` in `.dependency-cruiser.cjs` says why the edge is wrong and where the
shared piece belongs instead.

**Fix a violation by moving the code, not by widening a rule.** A carve-out in
`.dependency-cruiser.cjs` requires owner approval and must carry a `comment`
naming its removal condition.

## Two load-bearing invariants

These are the two ways this shape breaks *silently* — the tests can stay green.

**1. Module evaluation order in `src/server/index.ts` is load-bearing.**
`index.ts` performs the `.env` load and imports `./runtime` (the composition-root
state) **after** its `./db` import block, because `db.ts` and `provisioning.ts`
evaluate at module scope before that load and must keep doing so. Do not reorder
those imports. (The underlying quirk — `db.ts` never seeing `.env` — is a separate
deliberate fix, not a side effect of a refactor.)

**2. Route modules import database functions from `src/server/db` (the barrel),
never from `db-core.ts` or a `db/<domain>.ts` store directly.**
`tests/unit/ops-events-500-capture.test.ts` mocks the barrel by module id; a direct
store import bypasses the mock and the test passes while testing nothing. The
`barrel-is-the-db-surface` rule enforces this.

## Deliberate omissions

No web framework (Express/Fastify/Nest), no DI container, no ORM, no per-slice
package, no event bus. The raw-`http` ordered dispatch loop is the intended shape.
The problem this architecture solves is co-location, not framework style — do not
add machinery to "improve" it without the owner asking.
