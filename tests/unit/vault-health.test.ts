import { describe, expect, it } from 'vitest';
import {
  buildRouteProbe,
  checkVaultItem,
  classifyRouteProbe,
  type HealthProbe,
} from '../../src/lib/vault-health';
import { UNCHECKED_STALE_MS } from '../../src/lib/vault-policy';

const NOW = Date.parse('2026-10-16T12:00:00Z');

function probeReturning(status: number | 'error'): HealthProbe {
  return async () => status;
}

const ROUTE = {
  baseUrl: 'https://api.vendor.test/v1',
  authScheme: 'bearer',
  authHeader: null,
  bodyField: null,
  basicUsername: null,
  itemUsername: null,
  routeKey: 'vendor',
};

describe('vault health', () => {
  it('marks a rejected token stale', async () => {
    const verdict = await checkVaultItem(
      { kind: 'token', url: 'https://api.example.com/v1', createdAtMs: NOW },
      'secret',
      probeReturning(401),
      NOW
    );
    expect(verdict.status).toBe('stale');
  });

  it('verifies a Cloudflare token against the verify endpoint', async () => {
    let seen = '';
    const probe: HealthProbe = async (url) => {
      seen = url;
      return 200;
    };
    const verdict = await checkVaultItem(
      { kind: 'token', url: 'https://dash.cloudflare.com/profile/api-tokens', createdAtMs: NOW },
      'cf-token',
      probe,
      NOW
    );
    expect(seen).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    expect(verdict.status).toBe('healthy');
  });

  it('does not mark an item stale when the check cannot connect', async () => {
    const verdict = await checkVaultItem(
      { kind: 'token', url: 'https://api.example.com', createdAtMs: NOW },
      'secret',
      probeReturning('error'),
      NOW
    );
    expect(verdict.status).toBe('unchecked');
  });

  it('marks an item that was never checkable as stale after 30 days', async () => {
    const verdict = await checkVaultItem(
      { kind: 'token', url: null, createdAtMs: NOW - UNCHECKED_STALE_MS - 1000 },
      'secret',
      probeReturning('error'),
      NOW
    );
    expect(verdict.status).toBe('stale');
    expect(verdict.detail).toContain('30 days');
  });

  it('scores a password with zxcvbn instead of calling the network', async () => {
    let called = false;
    const probe: HealthProbe = async () => {
      called = true;
      return 500;
    };
    const verdict = await checkVaultItem(
      { kind: 'login', url: null, createdAtMs: NOW },
      'correct-horse-battery-staple',
      probe,
      NOW
    );
    expect(called).toBe(false);
    expect(verdict.detail).toContain('password score');
  });
});

describe('route health probe', () => {
  it('sends the base URL with the stored secret as a bearer token', () => {
    const request = buildRouteProbe(ROUTE, 'real-secret');
    expect(request?.url).toBe('https://api.vendor.test/v1');
    expect(request?.headers['Authorization']).toBe('Bearer real-secret');
  });

  it('puts the secret in the configured header for x-api-key', () => {
    const request = buildRouteProbe({ ...ROUTE, authScheme: 'x-api-key', authHeader: 'x-goog-api-key' }, 'real-secret');
    expect(request?.headers['x-goog-api-key']).toBe('real-secret');
    expect(request?.headers['Authorization']).toBeUndefined();
  });

  it('puts the secret in the query parameter', () => {
    const request = buildRouteProbe({ ...ROUTE, authScheme: 'query', authHeader: 'api_key' }, 'real-secret');
    expect(new URL(request!.url).searchParams.get('api_key')).toBe('real-secret');
  });

  it('fills the path template', () => {
    const request = buildRouteProbe({ ...ROUTE, authScheme: 'path', bodyField: '/bot{key}/getMe' }, 'real-secret');
    expect(request?.url).toBe('https://api.vendor.test/v1/botreal-secret/getMe');
  });

  it('encodes a basic credential from the item username', () => {
    const request = buildRouteProbe({ ...ROUTE, authScheme: 'basic', itemUsername: 'octo' }, 'real-secret');
    expect(request?.headers['Authorization']).toBe(`Basic ${Buffer.from('octo:real-secret').toString('base64')}`);
  });

  it('cannot probe a body_json route without a caller body', () => {
    expect(buildRouteProbe({ ...ROUTE, authScheme: 'body_json', bodyField: 'api_key' }, 'real-secret')).toBeNull();
  });

  it('never puts the working key in the probe', () => {
    const request = buildRouteProbe(ROUTE, 'real-secret');
    expect(JSON.stringify(request)).not.toContain('octo_tmp_');
  });
});

describe('route probe verdict', () => {
  it('counts a 404 at the base URL as reachable', () => {
    expect(classifyRouteProbe(404).status).toBe('ok');
  });

  it('flags a rejected key', () => {
    expect(classifyRouteProbe(401).status).toBe('unauthorized');
    expect(classifyRouteProbe(403).status).toBe('forbidden_group');
  });

  it('flags a vendor that is down or silent', () => {
    expect(classifyRouteProbe(503).status).toBe('unreachable');
    expect(classifyRouteProbe('error').status).toBe('unreachable');
  });
});
