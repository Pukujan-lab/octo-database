/**
 * Pure helpers for the credential egress relay: pull the working key from a
 * request, build the upstream request with the real secret injected, classify
 * the upstream status, and redact working keys from anything that might be
 * logged. No I/O lives here so every branch is unit-testable.
 */

import type { IncomingMessage } from 'node:http';

export const TEMP_KEY_PATTERN = /octo_tmp_[A-Za-z0-9_-]+/;
const TEMP_KEY_GLOBAL = /octo_tmp_[A-Za-z0-9_-]+/g;

export interface RelayRoute {
  baseUrl: string;
  authScheme: string;
  authHeader: string | null;
  bodyField: string | null;
  basicUsername: string | null;
  itemUsername: string | null;
}

export interface BuiltUpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

type IncomingHttpHeadersLike = Record<string, string | string[] | undefined>;

/**
 * Pulls the working key out of wherever the caller put it: Bearer, Basic, the
 * `x-api-key` header, the path, or a query parameter. Fails closed — no match
 * means the relay answers 401 and forwards nothing. Two *different* keys in
 * different positions are refused rather than guessed at; the same key in more
 * than one position is fine and is stripped from every one of them.
 */
export function extractTempKey(req: IncomingMessage, url: URL): { key: string | null; ambiguous: boolean } {
  const keys = new Set<string>();

  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const value = auth.slice(7).trim();
    if (TEMP_KEY_PATTERN.test(value)) keys.add(value);
  } else if (auth?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const [user, pass] = decoded.split(':');
      if (user && TEMP_KEY_PATTERN.test(user)) keys.add(user);
      if (pass && TEMP_KEY_PATTERN.test(pass)) keys.add(pass);
    } catch {
      // Not base64; the other positions still apply.
    }
  }

  const rawApiKey = req.headers['x-api-key'];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  if (apiKey && TEMP_KEY_PATTERN.test(apiKey)) keys.add(apiKey);

  const pathKey = url.pathname.match(TEMP_KEY_PATTERN);
  if (pathKey) keys.add(pathKey[0]);

  for (const value of Array.from(url.searchParams.values())) {
    const match = value.match(TEMP_KEY_PATTERN);
    if (match) keys.add(match[0]);
  }

  if (keys.size === 0) return { key: null, ambiguous: false };
  if (keys.size > 1) return { key: null, ambiguous: true };
  return { key: Array.from(keys)[0]!, ambiguous: false };
}

/**
 * Builds the vendor-facing request. The upstream origin is always the stored
 * base URL's origin — the caller controls only the path suffix, which cannot
 * escape it in path concatenation, and the result is asserted.
 *
 * The working key never reaches the vendor: it is replaced by the real secret
 * for the `path` scheme, and removed everywhere else.
 */
export function buildUpstreamRequest(input: {
  route: RelayRoute;
  secret: string;
  tempKey: string;
  method: string;
  url: URL;
  headers: IncomingHttpHeadersLike;
  body: Buffer | null;
}): BuiltUpstreamRequest | { error: string; status: number } {
  const base = new URL(input.route.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const suffix = input.url.pathname.replace(/^\/api\/vault\/relay\/[^/]+/, '');
  const upstream = new URL(base.origin + basePath + suffix + input.url.search);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'cookie' ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection' ||
      lower.startsWith('keep-alive') ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade' ||
      lower === 'accept-encoding'
    ) {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  let body = input.body;
  const encodedSecret = encodeURIComponent(input.secret);
  let pathHandled = false;

  switch (input.route.authScheme) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${input.secret}`;
      break;
    case 'x-api-key':
      headers[input.route.authHeader || 'x-api-key'] = input.secret;
      break;
    case 'basic': {
      const user = input.route.basicUsername || input.route.itemUsername || '';
      headers['Authorization'] = `Basic ${Buffer.from(`${user}:${input.secret}`).toString('base64')}`;
      break;
    }
    case 'query': {
      const param = input.route.authHeader;
      if (!param) return { error: 'ROUTE_INVALID', status: 500 };
      upstream.searchParams.set(param, input.secret);
      break;
    }
    case 'body_json': {
      if (!input.route.bodyField || !body) return { error: 'ROUTE_INVALID', status: 500 };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return { error: 'EGRESS_BODY_JSON', status: 400 };
      }
      const rewritten = replaceJsonLeaves(parsed, input.tempKey, input.secret);
      if (!rewritten.found) return { error: 'EGRESS_KEY_NOT_IN_BODY', status: 400 };
      body = Buffer.from(JSON.stringify(rewritten.value), 'utf8');
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = String(body.byteLength);
      break;
    }
    case 'path': {
      const template = input.route.bodyField;
      if (!template || !template.includes('{key}')) return { error: 'ROUTE_INVALID', status: 500 };
      const suffixPath = suffix.includes(input.tempKey)
        ? suffix.split(input.tempKey).join(encodedSecret)
        : template.replace('{key}', encodedSecret) + suffix;
      upstream.pathname = basePath + suffixPath;
      pathHandled = true;
      break;
    }
    default:
      return { error: 'ROUTE_INVALID', status: 500 };
  }

  // Strip any working key the caller left behind in a position this scheme
  // does not use, so it can never reach the vendor.
  if (!pathHandled) upstream.pathname = upstream.pathname.replace(TEMP_KEY_GLOBAL, '');
  for (const [name, value] of Array.from(upstream.searchParams.entries())) {
    if (TEMP_KEY_PATTERN.test(value)) upstream.searchParams.delete(name);
  }

  if (upstream.origin !== base.origin) {
    return { error: 'EGRESS_URL_INVALID', status: 400 };
  }
  return { url: upstream.toString(), headers, body };
}

/** Replaces every leaf exactly equal to the temp key, reporting whether one matched. */
export function replaceJsonLeaves(
  node: unknown,
  tempKey: string,
  secret: string
): { value: unknown; found: boolean } {
  if (typeof node === 'string') {
    return node === tempKey ? { value: secret, found: true } : { value: node, found: false };
  }
  if (Array.isArray(node)) {
    let found = false;
    const value = node.map((item) => {
      const result = replaceJsonLeaves(item, tempKey, secret);
      found = found || result.found;
      return result.value;
    });
    return { value, found };
  }
  if (node && typeof node === 'object') {
    let found = false;
    const value: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      const result = replaceJsonLeaves(item, tempKey, secret);
      value[key] = result.value;
      found = found || result.found;
    }
    return { value, found };
  }
  return { value: node, found: false };
}

/** Maps an upstream status (or network failure) onto the route health. */
export function classifyUpstream(status: number | 'error'): { status: string; detail: string } {
  if (status === 'error') return { status: 'unreachable', detail: 'upstream request failed' };
  if (status < 400) return { status: 'ok', detail: `upstream ${status}` };
  if (status === 401) return { status: 'unauthorized', detail: 'upstream rejected the key (401)' };
  if (status === 403) return { status: 'forbidden_group', detail: 'key valid but not entitled (403)' };
  return { status: 'unreachable', detail: `upstream ${status}` };
}

/** Replaces working keys in free text so logs and ops events never carry one. */
export function redactTempKeys(text: string): string {
  return text.replace(TEMP_KEY_GLOBAL, 'octo_tmp_<redacted>');
}
