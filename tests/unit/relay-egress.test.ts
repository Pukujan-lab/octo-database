import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  buildProxyRequest,
  buildUpstreamRequest,
  classifyUpstream,
  extractTempKey,
  redactTempKeys,
  replaceJsonLeaves,
  type RelayRoute,
} from '../../src/lib/relay-egress';

const KEY = 'octo_tmp_abcdefghijklmnopqrstuvwxyz012345';

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function route(overrides: Partial<RelayRoute> = {}): RelayRoute {
  return {
    baseUrl: 'https://api.vendor.test/v1',
    authScheme: 'bearer',
    authHeader: null,
    bodyField: null,
    basicUsername: null,
    itemUsername: null,
    ...overrides,
  };
}

function build(overrides: {
  route?: Partial<RelayRoute>;
  url?: string;
  headers?: Record<string, string>;
  body?: Buffer | null;
  tempKey?: string;
}) {
  return buildUpstreamRequest({
    route: route(overrides.route),
    secret: 'real-secret',
    tempKey: overrides.tempKey ?? KEY,
    method: 'GET',
    url: new URL(overrides.url ?? '/api/vault/relay/vendor/things?limit=5', 'https://octo.test'),
    headers: overrides.headers ?? {},
    body: overrides.body ?? null,
  });
}

describe('extractTempKey', () => {
  it('finds a Bearer working key', () => {
    const found = extractTempKey(request({ authorization: `Bearer ${KEY}` }), new URL('https://octo.test/x'));
    expect(found).toEqual({ key: KEY, ambiguous: false });
  });

  it('finds an x-api-key working key', () => {
    const found = extractTempKey(request({ 'x-api-key': KEY }), new URL('https://octo.test/x'));
    expect(found.key).toBe(KEY);
  });

  it('finds a working key in the path', () => {
    const found = extractTempKey(request({}), new URL(`https://octo.test/bot${KEY}/getMe`));
    expect(found.key).toBe(KEY);
  });

  it('finds a working key in a query parameter', () => {
    const found = extractTempKey(request({}), new URL(`https://octo.test/x?key=${KEY}`));
    expect(found.key).toBe(KEY);
  });

  it('finds a working key in the password side of Basic', () => {
    const value = Buffer.from(`user:${KEY}`).toString('base64');
    const found = extractTempKey(request({ authorization: `Basic ${value}` }), new URL('https://octo.test/x'));
    expect(found.key).toBe(KEY);
  });

  it('reports a missing key', () => {
    expect(extractTempKey(request({}), new URL('https://octo.test/x'))).toEqual({ key: null, ambiguous: false });
  });

  it('refuses two different keys in two positions', () => {
    const found = extractTempKey(
      request({ authorization: `Bearer ${KEY}` }),
      new URL(`https://octo.test/x?key=octo_tmp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz`)
    );
    expect(found).toEqual({ key: null, ambiguous: true });
  });

  it('accepts the same key in two positions', () => {
    const found = extractTempKey(request({ authorization: `Bearer ${KEY}` }), new URL(`https://octo.test/x?key=${KEY}`));
    expect(found).toEqual({ key: KEY, ambiguous: false });
  });
});

describe('buildUpstreamRequest', () => {
  it('injects a Bearer secret and keeps the path and query', () => {
    const built = build({ headers: { authorization: `Bearer ${KEY}`, 'x-api-key': KEY } });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.url).toBe('https://api.vendor.test/v1/things?limit=5');
    expect(built.headers['Authorization']).toBe('Bearer real-secret');
    expect(built.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(built.headers)).not.toContain(KEY);
  });

  it('injects an x-api-key secret under the configured header', () => {
    const built = build({
      route: { authScheme: 'x-api-key', authHeader: 'x-goog-api-key' },
      headers: { 'x-api-key': KEY },
    });
    if ('error' in built) throw new Error(built.error);
    expect(built.headers['x-goog-api-key']).toBe('real-secret');
    expect(built.headers['x-api-key']).toBeUndefined();
  });

  it('builds Basic from the route user, then the item user', () => {
    const fromRoute = build({ route: { authScheme: 'basic', basicUsername: 'route-user' } });
    if ('error' in fromRoute) throw new Error(fromRoute.error);
    expect(Buffer.from(fromRoute.headers['Authorization']!.slice(6), 'base64').toString()).toBe(
      'route-user:real-secret'
    );

    const fromItem = build({ route: { authScheme: 'basic', itemUsername: 'item-user' } });
    if ('error' in fromItem) throw new Error(fromItem.error);
    expect(Buffer.from(fromItem.headers['Authorization']!.slice(6), 'base64').toString()).toBe(
      'item-user:real-secret'
    );
  });

  it('sets a query parameter and removes the working key from the query', () => {
    const built = build({
      route: { authScheme: 'query', authHeader: 'api_key' },
      url: `/api/vault/relay/vendor/things?key=${KEY}&limit=5`,
    });
    if ('error' in built) throw new Error(built.error);
    const url = new URL(built.url);
    expect(url.searchParams.get('api_key')).toBe('real-secret');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(built.url).not.toContain(KEY);
  });

  it('rewrites a JSON body leaf', () => {
    const built = build({
      route: { authScheme: 'body_json', bodyField: 'api_key' },
      body: Buffer.from(JSON.stringify({ api_key: KEY, query: 'hello' })),
    });
    if ('error' in built) throw new Error(built.error);
    expect(JSON.parse(built.body!.toString())).toEqual({ api_key: 'real-secret', query: 'hello' });
    expect(built.headers['Content-Length']).toBe(String(built.body!.byteLength));
  });

  it('refuses a body that does not carry the working key', () => {
    const built = build({
      route: { authScheme: 'body_json', bodyField: 'api_key' },
      body: Buffer.from(JSON.stringify({ query: 'hello' })),
    });
    expect('error' in built && built.error).toBe('EGRESS_KEY_NOT_IN_BODY');
  });

  it('substitutes a working key inside the path (Telegram)', () => {
    const built = build({
      route: { authScheme: 'path', bodyField: 'bot{key}', baseUrl: 'https://api.telegram.org' },
      url: `/api/vault/relay/telegram/bot${KEY}/getMe`,
    });
    if ('error' in built) throw new Error(built.error);
    expect(built.url).toBe('https://api.telegram.org/botreal-secret/getMe');
    expect(built.url).not.toContain(KEY);
  });

  it('falls back to the path template when the caller omits the key', () => {
    const built = build({
      route: { authScheme: 'path', bodyField: 'bot{key}/getMe', baseUrl: 'https://api.telegram.org' },
      url: '/api/vault/relay/telegram',
    });
    if ('error' in built) throw new Error(built.error);
    expect(built.url).toBe('https://api.telegram.org/botreal-secret/getMe');
  });

  it('never forwards a working key left in an unused position', () => {
    const built = build({ url: `/api/vault/relay/vendor/bot${KEY}/things?key=${KEY}` });
    if ('error' in built) throw new Error(built.error);
    expect(built.url).not.toContain(KEY);
  });

  it('refuses a route with no usable scheme field', () => {
    expect('error' in build({ route: { authScheme: 'query', authHeader: null } })).toBe(true);
    expect('error' in build({ route: { authScheme: 'body_json', bodyField: null } })).toBe(true);
    expect('error' in build({ route: { authScheme: 'path', bodyField: null } })).toBe(true);
  });
});

describe('buildProxyRequest', () => {
  function proxy(overrides: {
    route?: Partial<RelayRoute>;
    targetUrl?: string;
    headers?: Record<string, string>;
    body?: Buffer | null;
    tempKey?: string;
  }) {
    return buildProxyRequest({
      targetUrl: overrides.targetUrl ?? 'https://api.other.test/v2/things?limit=5',
      route: route(overrides.route),
      secret: 'real-secret',
      tempKey: overrides.tempKey ?? KEY,
      headers: overrides.headers ?? {},
      body: overrides.body ?? null,
    });
  }

  it('uses the caller target, not the route base url', () => {
    const built = proxy({ headers: { authorization: `Bearer ${KEY}` } });
    if ('error' in built) throw new Error(built.error);
    expect(built.url).toBe('https://api.other.test/v2/things?limit=5');
    expect(built.headers['Authorization']).toBe('Bearer real-secret');
  });

  it('drops the target header so the vendor never sees it', () => {
    const built = proxy({ headers: { 'x-octo-target': 'https://api.other.test/v2/things' } });
    if ('error' in built) throw new Error(built.error);
    expect(built.headers['x-octo-target']).toBeUndefined();
  });

  it('substitutes a working key carried in the target path', () => {
    const built = proxy({
      route: { authScheme: 'path', bodyField: 'bot{key}', baseUrl: 'https://api.telegram.org' },
      targetUrl: `https://api.telegram.org/bot${KEY}/getMe`,
    });
    if ('error' in built) throw new Error(built.error);
    expect(built.url).toBe('https://api.telegram.org/botreal-secret/getMe');
  });

  it('fills a {key} placeholder in the caller target', () => {
    const built = proxy({
      route: { authScheme: 'path', bodyField: 'bot{key}', baseUrl: 'https://api.telegram.org' },
      targetUrl: 'https://api.telegram.org/bot{key}/getMe',
    });
    if ('error' in built) throw new Error(built.error);
    expect(built.url).toBe('https://api.telegram.org/botreal-secret/getMe');
  });

  it('strips a working key from the target query and injects the real secret', () => {
    const built = proxy({
      route: { authScheme: 'query', authHeader: 'api_key' },
      targetUrl: `https://api.other.test/v2/things?key=${KEY}&limit=5`,
    });
    if ('error' in built) throw new Error(built.error);
    const url = new URL(built.url);
    expect(url.searchParams.get('api_key')).toBe('real-secret');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(built.url).not.toContain(KEY);
  });

  it('refuses a target that is not an absolute http(s) url', () => {
    expect('error' in proxy({ targetUrl: 'not-a-url' })).toBe(true);
    expect('error' in proxy({ targetUrl: 'ftp://api.other.test/x' })).toBe(true);
  });
});

describe('replaceJsonLeaves', () => {
  it('replaces nested leaves and reports a match', () => {
    const result = replaceJsonLeaves({ a: [{ b: KEY }], c: 'keep' }, KEY, 'real');
    expect(result.found).toBe(true);
    expect(result.value).toEqual({ a: [{ b: 'real' }], c: 'keep' });
  });

  it('does not replace a substring', () => {
    const result = replaceJsonLeaves({ a: `prefix-${KEY}` }, KEY, 'real');
    expect(result.found).toBe(false);
    expect(result.value).toEqual({ a: `prefix-${KEY}` });
  });
});

describe('health and redaction', () => {
  it('classifies upstream statuses', () => {
    expect(classifyUpstream(200).status).toBe('ok');
    expect(classifyUpstream(401).status).toBe('unauthorized');
    expect(classifyUpstream(403).status).toBe('forbidden_group');
    expect(classifyUpstream('error').status).toBe('unreachable');
  });

  it('redacts working keys', () => {
    const text = `failed for ${KEY} at /x`;
    expect(redactTempKeys(text)).not.toContain(KEY);
    expect(redactTempKeys(text)).toContain('octo_tmp_<redacted>');
  });
});
