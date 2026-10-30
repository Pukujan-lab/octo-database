/**
 * Octo Full-Stack Platform Server
 *
 * Exposes REST APIs, API Gateway, and Cloudflare R2 active storage connector.
 * Executes all data mutations directly in PostgreSQL and Cloudflare R2.
 */

import { handleAnalyticsRoutes } from '../routes/analytics';
import { handleAuthRoutes } from '../routes/auth';
import { handleCapabilitiesRoutes } from '../routes/capabilities';
import { handleServicesRoutes } from '../routes/services';
import { handleEpistemicRoutes } from '../routes/epistemic';
import { handleFilesRoutes } from '../routes/files';
import { handleGalleryRoutes } from '../routes/gallery';
import { handleGraphRoutes } from '../routes/graph';
import { handleHealthRoutes } from '../routes/health';
import { handleJobsRoutes } from '../routes/jobs';
import { handleKeysRoutes } from '../routes/keys';
import { handleMcpRoutes } from '../routes/mcp';
import { handleMeRoutes } from '../routes/me';
import { handleOpsRoutes } from '../routes/ops';
import { handlePublicFilesRoutes } from '../routes/public-files';
import { handleRagRoutes } from '../routes/rag';
import { handleSharesRoutes } from '../routes/shares';
import { handleVaultRoutes } from '../routes/vault';
import { handleVaultRelayRoutes } from '../routes/vault-relay';
import { handleStaticRoutes } from '../routes/static';
import { handleWorkspaceQueryRoutes } from '../routes/workspace-query';
import { handleWorkspacesRoutes } from '../routes/workspaces';
import { runWithRequestIdentity } from './db';
import { RouteHandler, sendJson } from './http';
import { handleOAuthRoutes } from './oauth';
import { captureOpsEvent } from './ops';
import { runRetentionSweep, startSchedulers } from './queue';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { PORT, r2Provider } from './runtime';

/**
 * Resolves the public origin from PUBLIC_BASE_URL, X-Forwarded-* headers,
 * Host header, or fallback local URL origin. Defined in lib/public-origin so the
 * OAuth routes can share it without importing this module; re-exported here for
 * the callers and tests that already import it from the server.
 */
export { getPublicOrigin } from '../lib/public-origin';

export { getGoogleClientCredentials, getTurnstileSiteKey } from './google-auth';

/**
 * The ordered dispatch table. Each family returns true once it has handled the
 * request; the first match wins, so the order here is the routing contract.
 */
const ROUTES: RouteHandler[] = [
  handleHealthRoutes,
  handleOAuthRoutes,
  handleMcpRoutes,
  handlePublicFilesRoutes,
  handleAuthRoutes,
  handleMeRoutes,
  handleWorkspacesRoutes,
  handleFilesRoutes,
  handleGalleryRoutes,
  handleKeysRoutes,
  // Claims every /api/vault path and 404s unknown subpaths, so the relay family
  // must come first or its routes are never reached.
  handleVaultRelayRoutes,
  handleVaultRoutes,
  handleSharesRoutes,
  handleCapabilitiesRoutes,
  handleServicesRoutes,
  handleJobsRoutes,
  handleOpsRoutes,
  handleRagRoutes,
  handleEpistemicRoutes,
  handleGraphRoutes,
  handleWorkspaceQueryRoutes,
  handleAnalyticsRoutes,
  handleStaticRoutes,
];

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    });
    res.end();
    return;
  }

  // A malformed request target (for example the absolute-form `http://[`) makes
  // URL() throw ERR_INVALID_URL. Constructing it before the try below would turn
  // that into an unhandled rejection that terminates the single-process host, so
  // answer the bad request instead of dying on it.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST: malformed request target' });
    return;
  }
  const pathname = url.pathname;

  try {
    for (const route of ROUTES) {
      if (await route(req, res, url)) return;
    }

    // 404 for unknown route
    sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await captureOpsEvent(req, url, {
      eventType: 'request.error',
      errorCode: 'INTERNAL_SERVER_ERROR',
      detail: { message, method: req.method, path: pathname },
    });
    sendJson(res, 500, { error: `INTERNAL_SERVER_ERROR: ${message}` });
  }
}

// Every request runs inside a fresh identity holder so concurrent requests can
// never share RLS claims. `authenticateRequest` fills it in; `query()` binds it,
// transaction-scoped, on the fenced app pool.
export const server = createServer((req, res) => {
  void runWithRequestIdentity(() => handleRequest(req, res));
});

// Start listening if run directly. Compare on the basename so the guard holds on
// Windows too, where argv[1] is a backslash path and never matches 'server/index.ts'.
const entryFile = process.argv[1] ? path.basename(process.argv[1]) : '';
if (
  (entryFile === 'index.ts' || entryFile === 'index.js') &&
  path.basename(path.dirname(process.argv[1]!)) === 'server'
) {
  server.listen(PORT, () => {
    console.log(`Octo Platform Server listening on http://localhost:${PORT}`);
    console.log(`- Health: http://localhost:${PORT}/health`);
    console.log(`- Guest Login: POST http://localhost:${PORT}/api/auth/guest`);
    console.log(`- R2 Active Bucket: ${r2Provider ? r2Provider.bucket : 'none'}`);
    // Apply the retention policy once at boot, then on the hourly tick, so a
    // deployment does not wait up to an hour to honour an existing window.
    void runRetentionSweep()
      .then((enqueued) => {
        if (enqueued > 0) console.log(`Retention sweep enqueued ${enqueued} archive job(s)`);
      })
      .catch((err) => console.warn('Retention sweep failed:', err));
    startSchedulers();
  });
}
