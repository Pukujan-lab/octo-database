import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npx tsx src/server/index.ts',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 30000,
      env: {
        // CI/dev has no R2 credentials; the local backend must be opted into
        // explicitly so production still fails closed without R2.
        OCTO_STORAGE_BACKEND: process.env['OCTO_STORAGE_BACKEND'] ?? 'local',
        OCTO_MEDIA_SECRET: process.env['OCTO_MEDIA_SECRET'] ?? 'e2e-media-secret',
        // Key material for the per-principal MFA secret envelope (Slice 17).
        OCTO_MFA_SECRET: process.env['OCTO_MFA_SECRET'] ?? 'e2e-mfa-secret',
        // Signs bearer session tokens (ISS-1). A stable value across the server
        // and test processes lets the e2e suite forge a correctly-signed token.
        OCTO_SESSION_SECRET: process.env['OCTO_SESSION_SECRET'] ?? 'e2e-session-secret',
        // Signs the OAuth access tokens the /mcp authorization server mints. A
        // stable value keeps issued tokens verifiable across a server restart.
        OCTO_OAUTH_SECRET: process.env['OCTO_OAUTH_SECRET'] ?? 'e2e-oauth-secret',
        DATABASE_URL:
          process.env['DATABASE_URL'] ??
          'postgresql://postgres:postgres@localhost:54329/postgres',
        // The privileged provisioning connection (Slice 20). In CI the schema owner
        // is the same superuser DATABASE_URL points at, so the workspace-database
        // E2E can provision a real database and then query it through the SQL
        // surface (Slice 21). A deployment points this at its own admin credential.
        OCTO_ADMIN_URL:
          process.env['OCTO_ADMIN_URL'] ??
          process.env['DATABASE_URL'] ??
          'postgresql://postgres:postgres@localhost:54329/postgres',
        // When set, the server runs its request path as the fenced `octo_app` role
        // (Slice 14). Left unset locally, the server falls back to DATABASE_URL.
        ...(process.env['OCTO_DB_URL'] ? { OCTO_DB_URL: process.env['OCTO_DB_URL'] } : {}),
        ...(process.env['OCTO_SERVICE_URL']
          ? { OCTO_SERVICE_URL: process.env['OCTO_SERVICE_URL'] }
          : {}),
        // The graph engine is optional. Passed through only when a runner supplies
        // it, so the configured-path eval runs where a FalkorDB is present and the
        // unconfigured path (503, not advertised) runs everywhere else.
        ...(process.env['OCTO_GRAPH_URL'] ? { OCTO_GRAPH_URL: process.env['OCTO_GRAPH_URL'] } : {}),
      },
    },
    {
      command: 'npm --prefix frontend run dev',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env['CI'],
      timeout: 30000,
    },
  ],
});
