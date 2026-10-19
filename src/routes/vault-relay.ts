/**
 * Credential egress relay.
 *
 * A working key (`octo_tmp_…`) is a real credential the owner can attach to a
 * program: requests carrying it arrive here, Octo swaps in the stored vendor
 * secret, and forwards upstream. The vendor secret never leaves Octo, and the
 * working key never reaches the vendor.
 *
 * `/api/vault/proxy` is the free-form path: the caller names any http(s)
 * upstream per request, so a working key is not pinned to one base URL. The
 * older `/api/vault/relay/<routeKey>` remains for routes created in the
 * dashboard.
 *
 * This family is registered before handleVaultRoutes in src/server/index.ts,
 * because that family claims every /api/vault path and would 404 these.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashApiKeySecret } from '../lib/secret-hash';
import { decryptSecret } from '../lib/mfa';
import {
  buildProxyRequest,
  buildUpstreamRequest,
  classifyUpstream,
  extractTempKey,
  redactTempKeys,
  type BuiltUpstreamRequest,
} from '../lib/relay-egress';
import { parseLeaseDays } from '../lib/vault-policy';
import {
  dbConsumeVaultLease,
  dbConsumeVaultLeaseByKey,
  dbGetVaultLeaseByKey,
  dbRenewVaultLease,
  dbUpdateVaultRouteHealth,
  type ConsumedVaultLeaseAny,
} from '../server/db';
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

  return forwardUpstream({
    req,
    res,
    built,
    method,
    hasBody,
    buffered,
    onUpstream: (status, detail) => {
      const health = classifyUpstream(status);
      void dbUpdateVaultRouteHealth(lease.principalId, lease.routeId, health.status, detail ?? health.detail).catch(
        () => undefined
      );
    },
  });
}

/**
 * Sends the built request upstream and streams the answer back. Shared by the
 * pinned route relay and the free-form proxy so both behave identically.
 */
async function forwardUpstream(input: {
  req: IncomingMessage;
  res: ServerResponse;
  built: BuiltUpstreamRequest;
  method: string;
  hasBody: boolean;
  buffered: Buffer | null;
  onUpstream?: (status: number | 'error', detail?: string) => void;
}): Promise<true> {
  const controller = new AbortController();
  input.req.on('aborted', () => controller.abort());
  input.res.on('close', () => controller.abort());

  const streamedBody =
    input.hasBody && !input.buffered ? (Readable.toWeb(input.req) as unknown as ReadableStream) : input.buffered;

  let upstream: Response;
  try {
    upstream = await fetch(input.built.url, {
      method: input.method,
      headers: input.built.headers,
      body: streamedBody,
      duplex: 'half',
      redirect: 'manual',
      signal: controller.signal,
    } as RequestInit);
  } catch (error) {
    const detail = redactTempKeys(error instanceof Error ? error.message : String(error));
    input.onUpstream?.('error', detail);
    if (!input.res.headersSent) sendJson(input.res, 502, { error: 'EGRESS_FAILED: the vendor did not answer.' });
    return true;
  }

  input.onUpstream?.(upstream.status);

  input.res.writeHead(upstream.status, upstreamHeaders(upstream.headers));
  if (!upstream.body) {
    input.res.end();
    return true;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), input.res);
  } catch {
    // Headers are already out; killing the socket is the only honest answer.
    input.res.destroy();
  }
  return true;
}

/**
 * The caller names the upstream. An absolute http(s) URL is used as-is; a
 * relative path resolves against the lease's default upstream.
 */
function resolveTarget(raw: string | null, defaultTarget: string | null): string | null {
  if (!raw) return defaultTarget;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!defaultTarget) return null;
  return defaultTarget.replace(/\/+$/, '') + (raw.startsWith('/') ? raw : `/${raw}`);
}

/** Target from x-octo-target, then ?target=, then the path after /api/vault/proxy. */
function proxyTarget(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['x-octo-target'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader?.trim()) return fromHeader.trim();

  const fromQuery = url.searchParams.get('target');
  if (fromQuery?.trim()) return fromQuery.trim();

  const suffix = url.pathname.replace(/^\/api\/vault\/proxy\/?/, '');
  if (!suffix) return null;
  try {
    return decodeURIComponent(suffix) + url.search;
  } catch {
    return suffix + url.search;
  }
}

/**
 * Free-form egress: the working key carries the injection recipe, the caller
 * names any upstream per request. No route is involved, so the key is never
 * pinned to one base URL.
 */
async function proxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { key, ambiguous } = extractTempKey(req, url);
  if (ambiguous) {
    sendJson(res, 400, { error: 'WORKING_KEY_AMBIGUOUS: send exactly one working key.' });
    return true;
  }
  if (!key) {
    sendJson(res, 401, { error: 'WORKING_KEY_MISSING: attach the working key.' });
    return true;
  }

  const lease: ConsumedVaultLeaseAny | null = await dbConsumeVaultLeaseByKey(hashApiKeySecret(key));
  if (!lease || !lease.secretEncrypted) {
    sendJson(res, 401, { error: 'WORKING_KEY_INVALID: that key is unknown, expired, or revoked.' });
    return true;
  }

  const targetUrl = resolveTarget(proxyTarget(req, url), lease.baseUrl);
  if (!targetUrl) {
    sendJson(res, 400, {
      error:
        'TARGET_REQUIRED: name the vendor URL in x-octo-target, in ?target=, or as the path after /api/vault/proxy.',
      code: 'TARGET_REQUIRED',
    });
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

  const built = buildProxyRequest({
    targetUrl,
    route: {
      baseUrl: lease.baseUrl ?? targetUrl,
      authScheme: lease.authScheme,
      authHeader: lease.authHeader,
      bodyField: lease.bodyField,
      basicUsername: lease.basicUsername,
      itemUsername: lease.itemUsername,
    },
    secret,
    tempKey: key,
    headers: req.headers,
    body: buffered,
  });
  if ('error' in built) {
    sendJson(res, built.status, { error: `${built.error}: the proxy could not build an upstream request.` });
    return true;
  }

  return forwardUpstream({ req, res, built, method, hasBody, buffered });
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

  if (path === '/api/vault/proxy' || path.startsWith('/api/vault/proxy/')) {
    return proxy(req, res, url);
  }

  const match = path.match(/^\/api\/vault\/relay\/([a-z0-9][a-z0-9-]*)(\/.*)?$/);
  if (!match) return false;
  const routeKey = match[1]!;
  return relay(req, res, url, routeKey);
};
