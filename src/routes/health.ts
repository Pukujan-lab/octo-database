/**
 * Health and readiness for the database and object store.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { analyticsEngineStatus } from '../analytics/engine';
import { testDbConnection } from '../server/db';
import { getGoogleClientCredentials, getTurnstileSiteKey } from '../server/google-auth';
import { sendJson } from '../server/http';
import { r2Provider } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleHealthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 1. Health check (tests both PostgreSQL and Cloudflare R2 connections)
  if (pathname === '/health' && req.method === 'GET') {
    const dbStatus = await testDbConnection();
    const r2Status = r2Provider ? await r2Provider.testConnection() : { connected: false, bucket: 'none' };
    const { clientId } = getGoogleClientCredentials();
    sendJson(res, 200, {
      status: 'ok',
      version: '0.1.0',
      database: dbStatus,
      r2: r2Status,
      googleAuthEnabled: Boolean(clientId),
      turnstileSiteKey: getTurnstileSiteKey(),
      analytics: await analyticsEngineStatus(),
    });
    return true;
  }

  return false;
}
