/**
 * The relay must never hand the stored secret back to a working-key holder.
 * A local vendor redirects (with the secret in `Location`, as MTA Bus Time
 * does) and echoes everything it received in headers and body; the test
 * asserts no spelling of the secret survives the trip, for each auth scheme
 * and through both `/api/vault/proxy` and `/api/vault/relay/<route>`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A fixture, not a real credential. `/` and `+` make the encoded forms differ.
const SECRET = 'fixture/secret+0123456789';
const WORKING_KEY = 'octo_tmp_fixtureworkingkey0123456789';

const lease = {
  leaseId: 'lease-1',
  principalId: 'p1',
  itemId: 'item-1',
  routeId: 'route-1',
  baseUrl: '',
  authScheme: 'bearer',
  authHeader: null as string | null,
  bodyField: null,
  basicUsername: null,
  itemUsername: null,
  secretEncrypted: 'encrypted',
  expiresAt: '2099-01-01T00:00:00Z',
};

vi.mock('../../src/server/db', () => ({
  dbConsumeVaultLease: vi.fn(async () => lease),
  dbConsumeVaultLeaseByKey: vi.fn(async () => lease),
  dbGetVaultLeaseByKey: vi.fn(async () => null),
  dbRenewVaultLease: vi.fn(async () => null),
  dbUpdateVaultRouteHealth: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/mfa', () => ({ decryptSecret: () => SECRET }));

import { handleVaultRelayRoutes } from '../../src/routes/vault-relay';

/** Every request the vendor saw, so the test can prove the secret did reach it. */
const seen: { path: string; query: URLSearchParams; headers: IncomingMessage['headers'] }[] = [];

let vendor: Server;
let octo: Server;
let vendorOrigin = '';
let octoOrigin = '';

function echo(req: IncomingMessage) {
  return JSON.stringify({ url: req.url, headers: req.headers });
}

beforeAll(async () => {
  vendor = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://vendor.local');
    seen.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    const echoed = { 'x-echo-auth': String(req.headers['authorization'] ?? ''), 'x-echo-url': req.url ?? '' };
    if (url.pathname === '/start') {
      // Relative, carrying the whole query (the secret included), like MTA.
      res.writeHead(302, { location: `/final${url.search}`, ...echoed });
      res.end(echo(req));
    } else if (url.pathname === '/away') {
      res.writeHead(302, { location: `http://elsewhere.invalid/next${url.search}`, ...echoed });
      res.end();
    } else if (url.pathname === '/loop') {
      res.writeHead(302, { location: `/loop${url.search}` });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...echoed });
      res.end(echo(req));
    }
  });
  await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
  vendorOrigin = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;

  octo = createServer((req, res) => {
    void handleVaultRelayRoutes(req, res, new URL(req.url ?? '/', 'http://octo.local')).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => octo.listen(0, '127.0.0.1', resolve));
  octoOrigin = `http://127.0.0.1:${(octo.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => octo.close(resolve));
  await new Promise((resolve) => vendor.close(resolve));
});

beforeEach(() => {
  seen.length = 0;
  lease.baseUrl = vendorOrigin;
});

const SCHEMES = [
  { authScheme: 'query', authHeader: 'key' },
  { authScheme: 'x-api-key', authHeader: 'x-api-key' },
  { authScheme: 'bearer', authHeader: null },
  { authScheme: 'basic', authHeader: null },
] as const;

const FORMS = [
  SECRET,
  encodeURIComponent(SECRET),
  new URLSearchParams({ k: SECRET }).toString().slice(2),
  Buffer.from(`:${SECRET}`).toString('base64'),
];

function expectNoSecret(text: string) {
  for (const form of FORMS) expect(text).not.toContain(form);
}

async function call(path: string): Promise<{ status: number; headers: string; body: string; location: string | null }> {
  const response = await fetch(`${octoOrigin}${path}`, {
    headers: { 'x-api-key': WORKING_KEY },
    redirect: 'manual',
  });
  const headers = JSON.stringify(Array.from(response.headers.entries()));
  return { status: response.status, headers, body: await response.text(), location: response.headers.get('location') };
}

function injected(hop: (typeof seen)[number]): boolean {
  switch (lease.authScheme) {
    case 'query':
      return hop.query.get('key') === SECRET;
    case 'x-api-key':
      return hop.headers['x-api-key'] === SECRET;
    case 'bearer':
      return hop.headers['authorization'] === `Bearer ${SECRET}`;
    default:
      return hop.headers['authorization'] === `Basic ${Buffer.from(`:${SECRET}`).toString('base64')}`;
  }
}

const ENTRYPOINTS = [
  { name: 'proxy', path: (vendorPath: string) => `/api/vault/proxy?target=${encodeURIComponent(vendorOrigin + vendorPath)}` },
  { name: 'relay route', path: (vendorPath: string) => `/api/vault/relay/vendor${vendorPath}` },
];

describe.each(SCHEMES)('relay with the $authScheme scheme', (scheme) => {
  beforeEach(() => {
    lease.authScheme = scheme.authScheme;
    lease.authHeader = scheme.authHeader;
  });

  describe.each(ENTRYPOINTS)('through the $name', (entry) => {
    it('follows a same-origin redirect itself and scrubs the echoed secret', async () => {
      const result = await call(entry.path('/start?version=2'));

      expect(result.status).toBe(200);
      expect(result.location).toBeNull();
      expectNoSecret(result.headers);
      expectNoSecret(result.body);
      expect(result.body).toContain('octo_secret_redacted');

      // The vendor did get the secret on both hops, re-injected on the second.
      expect(seen.map((hop) => hop.path)).toEqual(['/start', '/final']);
      expect(injected(seen[1]!)).toBe(true);
      expect(seen[1]!.query.get('version')).toBe('2');
    });

    it('does not follow a cross-origin redirect, and scrubs its Location', async () => {
      const result = await call(entry.path('/away?version=2'));

      expect(result.status).toBe(302);
      expectNoSecret(result.headers);
      expect(result.location).toMatch(/^http:\/\/elsewhere\.invalid\/next/);
      expect(seen).toHaveLength(1);
    });

    it('stops after a bounded number of hops and returns an absolute, scrubbed Location', async () => {
      const result = await call(entry.path('/loop?version=2'));

      expect(result.status).toBe(302);
      expectNoSecret(result.headers);
      expect(result.location?.startsWith(vendorOrigin)).toBe(true);
      expect(seen.length).toBe(6);
    });
  });
});
