/**
 * Import-boundary rules for Octo's modular monolith.
 *
 * The shape (see docs/ARCHITECTURE.md):
 *   src/routes/<family>.ts   one HTTP route family, thin controllers
 *   src/server/              composition root, request plumbing, per-domain SQL stores
 *   src/<domain>/            slice services (auth, storage, media, jobs, rag, graph, ...)
 *   src/lib/, src/types/     leaves — no I/O, no upward imports
 *
 * The rule is machine-checked: `npm run lint:imports` runs inside the required
 * `gates` check, so a boundary violation fails CI rather than surviving review.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means two slices own each other. Move the shared piece down to src/lib or src/types.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'types-and-lib-are-leaves',
      severity: 'error',
      comment:
        'src/types and src/lib sit at the bottom of the stack; they must not reach up into a domain, the server, or routes.',
      from: { path: '^src/(lib|types)/' },
      to: {
        path: '^src/(server|routes|api|auth|media|storage|jobs|rag|graph|sync|backup|triage|mcp|qa)/',
      },
    },
    {
      name: 'only-server-and-routes-import-server',
      severity: 'error',
      comment:
        'src/server is reachable only from the composition root, route modules, and the operator scripts (the entry-point layer); domain services depend on src/lib and src/types, not on the server internals.',
      from: { pathNot: '^(src/(server|routes)/|scripts/)' },
      to: { path: '^src/server/' },
    },
    {
      name: 'routes-do-not-import-sibling-routes',
      severity: 'error',
      comment:
        'Route modules are independent slices. Share through src/server/* plumbing, src/lib, or src/types.',
      from: { path: '^src/routes/' },
      to: { path: '^src/routes/' },
    },
    {
      name: 'routes-do-not-import-the-entry',
      severity: 'error',
      comment:
        'src/server/index.ts is the composition root and imports the route modules; the reverse is a cycle.',
      from: { path: '^src/routes/' },
      to: { path: '^src/server/index\\.ts$' },
    },
    {
      name: 'barrel-is-the-db-surface',
      severity: 'error',
      comment:
        'Import database functions from src/server/db (the barrel), never db-core.ts or a db/<domain>.ts store. tests/unit/ops-events-500-capture.test.ts mocks the barrel by module id; a direct store import bypasses the mock.',
      from: { path: '^src/', pathNot: '^src/server/(db\\.ts|db-core\\.ts|db/)' },
      to: { path: '^src/server/(db-core\\.ts|db/)' },
    },
    {
      name: 'only-db-core-owns-request-identity',
      severity: 'error',
      comment:
        'Exactly one AsyncLocalStorage, in the db core module (db.ts today; db-core.ts once the store split lands). A second instance makes requestIdentity.getStore() return undefined and silently drops the RLS claims while the tests still pass.',
      from: { pathNot: '^src/server/db(-core)?\\.ts$' },
      to: { path: 'async_hooks' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
  },
};
