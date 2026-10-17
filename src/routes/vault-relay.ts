/**
 * Credential egress relay.
 *
 * A working key (`octo_tmp_…`) is a real credential the owner can attach to a
 * program: requests carrying it arrive here, Octo swaps in the stored vendor
 * secret, and forwards upstream. The vendor secret never leaves Octo, and the
 * working key never reaches the vendor.
 *
 * This family is registered before handleVaultRoutes in src/server/index.ts,
 * because that family claims every /api/vault path and would 404 these.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashApiKeySecret } from '../lib/secret-hash';
import { decryptSecret } from '../lib/mfa';
import {
  buildUpstreamRequest,
  classifyUpstream,
  extractTempKey,
  redactTempKeys,
} from '../lib/relay-egress';
import { parseLeaseDays } from '../lib/vault-policy';
import { dbConsumeVaultLease, dbGetVaultLeaseByKey, dbRenewVaultLease, dbUpdateVaultRouteHealth } from '../server/db';
import { readJsonObject, sendJson, type RouteHandler } from '../server/http';
import type { IncomingMessage, ServerResponse } from 'http';

const BODY_MAX_BYTES = 1024 * 1024;

function readBodyLimited(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > max) {
      resolve(null);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
  return promise;
}

function upstreamHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Array.from(headers.entries())) {
    const lower = name.toLowerCase();
    if (
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'content-encoding' ||
      lower === 'content-length'
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

async function relay(req: IncomingMessage, res: ServerResponse, url: URL, routeKey: string): Promise<boolean> {
  const { key, ambiguous } = extractTempKey(req, url);
  if (ambiguous) {
    sendJson(res, 400, { error: 'WORKING_KEY_AMBIGUOUS: send exactly one working key.' });
    return true;
  }
  if (!key) {
    sendJson(res, 401, { error: 'WORKING_KEY_MISSING: attach the working key the way this route expects.' });
    return true;
  }

  const lease = await dbConsumeVaultLease(hashApiKeySecret(key), routeKey);
  if (!lease || !lease.secretEncrypted) {
    sendJson(res, 401, { error: 'WORKING_KEY_INVALID: that key is unknown, expired, revoked, or not valid for this route.' });
    return true;
  }

  const secret = decryptSecret(lease.secretEncrypted);
  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  let buffered: Buffer | null = null;
  if (hasBody && lease.authScheme === 'body_json') {
    buffered = await readBodyLimited(req, BODY_MAX_BYTES);
    if (!buffered) {
      sendJson(res, 413, { error: 'BODY_TOO_LARGE: a rewritten body must be 1 MB or smaller.' });
      return true;
    }
  }

  const built = buildUpstreamRequest({
    route: {
      baseUrl: lease.baseUrl,
      authScheme: lease.authScheme,
      authHeader: lease.authHeader,
      bodyField: lease.bodyField,
      basicUsername: lease.basicUsername,
      itemUsername: lease.itemUsername,
    },
    secret,
    tempKey: key,
    method,
    url,
    headers: req.headers,
    body: buffered,
  });
  if ('error' in built) {
    sendJson(res, built.status, { error: `${built.error}: the route could not build an upstream request.` });
    return true;
  }

  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => controller.abort());

  const streamedBody = hasBody && !buffered ? (Readable.toWeb(req) as unknown as ReadableStream) : buffered;

  let upstream: Response;
  try {
    upstream = await fetch(built.url, {
      method,
      headers: built.headers,
      body: streamedBody,
      duplex: 'half',
      redirect: 'manual',
      signal: controller.signal,
    } as RequestInit);
  } catch (error) {
    const detail = redactTempKeys(error instanceof Error ? error.message : String(error));
    void dbUpdateVaultRouteHealth(lease.principalId, lease.routeId, 'unreachable', detail).catch(() => undefined);
    if (!res.headersSent) sendJson(res, 502, { error: 'EGRESS_FAILED: the vendor did not answer.' });
    return true;
  }

  const health = classifyUpstream(upstream.status);
  void dbUpdateVaultRouteHealth(lease.principalId, lease.routeId, health.status, health.detail).catch(() => undefined);

  res.writeHead(upstream.status, upstreamHeaders(upstream.headers));
  if (!upstream.body) {
    res.end();
    return true;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
  } catch {
    // Headers are already out; killing the socket is the only honest answer.
    res.destroy();
  }
  return true;
}

export const handleVaultRelayRoutes: RouteHandler = async (req, res, url) => {
  const path = url.pathname;

  if (path === '/api/vault/lease/renew' && req.method === 'POST') {
    const { key, ambiguous } = extractTempKey(req, url);
    if (ambiguous) {
      sendJson(res, 400, { error: 'WORKING_KEY_AMBIGUOUS: send exactly one working key.' });
      return true;
    }
    if (!key) {
      sendJson(res, 401, { error: 'WORKING_KEY_MISSING: attach the working key.' });
      return true;
    }
    const body = await readJsonObject(req);
    const days = parseLeaseDays(body['expiresInDays']);
    if (!days.ok) {
      sendJson(res, 400, { error: days.error });
      return true;
    }
    const expiresAt = await dbRenewVaultLease(hashApiKeySecret(key), days.days);
    if (!expiresAt) {
      sendJson(res, 401, { error: 'LEASE_EXPIRED: that working key has expired or been revoked.' });
      return true;
    }
    sendJson(res, 200, { expiresAt });
    return true;
  }

  if (path === '/api/vault/lease/info' && req.method === 'GET') {
    const { key, ambiguous } = extractTempKey(req, url);
    if (ambiguous) {
      sendJson(res, 400, { error: 'WORKING_KEY_AMBIGUOUS: send exactly one working key.' });
      return true;
    }
    if (!key) {
      sendJson(res, 401, { error: 'WORKING_KEY_MISSING: attach the working key.' });
      return true;
    }
    const lease = await dbGetVaultLeaseByKey(hashApiKeySecret(key));
    if (!lease) {
      sendJson(res, 401, { error: 'LEASE_EXPIRED: that working key has expired or been revoked.' });
      return true;
    }
    sendJson(res, 200, {
      lease: {
        id: lease.id,
        itemId: lease.itemId,
        itemLabel: lease.itemLabel,
        prefix: lease.prefix,
        expiresAt: lease.expiresAt,
        lastUsedAt: lease.lastUsedAt,
      },
    });
    return true;
  }

  const match = path.match(/^\/api\/vault\/relay\/([a-z0-9][a-z0-9-]*)(\/.*)?$/);
  if (!match) return false;
  const routeKey = match[1]!;
  return relay(req, res, url, routeKey);
};
