import { describe, expect, it } from 'vitest';
import {
  GRANT_DEFAULT_HOURS,
  LEASE_DEFAULT_DAYS,
  leaseExpiresAt,
  parseGrantHours,
  parseLeaseDays,
  parseUrlKind,
  parseVaultItem,
  parseVaultRoute,
  routeKeySlug,
} from '../../src/lib/vault-policy';

const WORKSPACE = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

describe('vault grant lifetime', () => {
  it('defaults to 24 hours', () => {
    expect(parseGrantHours(undefined)).toEqual({ ok: true, hours: GRANT_DEFAULT_HOURS });
    expect(parseGrantHours('')).toEqual({ ok: true, hours: 24 });
  });

  it('accepts 5 hours, 10 hours, and 3 days', () => {
    expect(parseGrantHours(5)).toEqual({ ok: true, hours: 5 });
    expect(parseGrantHours('10')).toEqual({ ok: true, hours: 10 });
    expect(parseGrantHours(72)).toEqual({ ok: true, hours: 72 });
  });

  it('rejects a lifetime outside 5 through 72 hours', () => {
    expect(parseGrantHours(4).ok).toBe(false);
    expect(parseGrantHours(73).ok).toBe(false);
    expect(parseGrantHours(24.5).ok).toBe(false);
  });
});

describe('vault items', () => {
  it('accepts a token assigned to a workspace', () => {
    const parsed = parseVaultItem(
      {
        label: 'Cloudflare',
        description: 'Account token for the gravebuster zone. Not the R2 token.',
        kind: 'token',
        secret: 'cf-real',
        url: 'https://api.cloudflare.com/client/v4',
      },
      WORKSPACE
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.workspaceId).toBe(WORKSPACE);
  });

  it('accepts an account item when no workspace is set', () => {
    const parsed = parseVaultItem(
      { label: 'Notes', description: 'Desk drawer code for the studio.', kind: 'note', notes: 'desk code' },
      null
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.workspaceId).toBeNull();
  });

  it('refuses an empty item', () => {
    expect(parseVaultItem({ label: 'Empty', description: 'A login with no secret.', kind: 'login' }, null).ok).toBe(false);
  });

  it('requires a description on a password and on a token', () => {
    expect(parseVaultItem({ label: 'Mail', kind: 'login', secret: 'hunter2' }, null).ok).toBe(false);
    expect(parseVaultItem({ label: 'Cloudflare', kind: 'token', secret: 'cf' }, null).ok).toBe(false);
  });
});

describe('working-key lifetime', () => {
  it('defaults to 15 days', () => {
    expect(parseLeaseDays(undefined)).toEqual({ ok: true, days: LEASE_DEFAULT_DAYS });
    expect(parseLeaseDays('')).toEqual({ ok: true, days: 15 });
  });

  it('accepts 1 through 30 whole days', () => {
    expect(parseLeaseDays(1)).toEqual({ ok: true, days: 1 });
    expect(parseLeaseDays('30')).toEqual({ ok: true, days: 30 });
  });

  it('rejects zero, beyond 30, and fractional days', () => {
    expect(parseLeaseDays(0).ok).toBe(false);
    expect(parseLeaseDays(31).ok).toBe(false);
    expect(parseLeaseDays(15.5).ok).toBe(false);
  });

  it('counts expiry from now', () => {
    const now = Date.parse('2026-10-17T00:00:00.000Z');
    expect(leaseExpiresAt(15, now)).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('url kinds', () => {
  it('keeps a kind on a url item', () => {
    expect(parseUrlKind('docs', 'url')).toEqual({ ok: true, value: 'docs' });
    expect(parseUrlKind('s3_endpoint', 'url')).toEqual({ ok: true, value: 's3_endpoint' });
  });

  it('drops a kind on anything that is not a url item', () => {
    expect(parseUrlKind('docs', 'token')).toEqual({ ok: true, value: null });
  });

  it('refuses an unknown kind', () => {
    expect(parseUrlKind('homepage', 'url').ok).toBe(false);
  });
});

describe('credential routes', () => {
  it('accepts a bearer route', () => {
    const parsed = parseVaultRoute({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      authScheme: 'bearer',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.routeKey).toBeNull();
  });

  it('accepts a body_json route with its leaf', () => {
    const parsed = parseVaultRoute({
      name: 'Tavily',
      baseUrl: 'https://api.tavily.com',
      authScheme: 'body_json',
      bodyField: 'api_key',
    });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a path route with its template', () => {
    const parsed = parseVaultRoute({
      name: 'Telegram',
      baseUrl: 'https://api.telegram.org',
      authScheme: 'path',
      bodyField: 'bot{key}/getMe',
    });
    expect(parsed.ok).toBe(true);
  });

  it('requires a header or parameter for header-style schemes', () => {
    expect(parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'x-api-key' }).ok).toBe(false);
    expect(parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'query' }).ok).toBe(false);
    expect(
      parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'query', authHeader: 'key' }).ok
    ).toBe(true);
  });

  it('requires a body field for body_json and path', () => {
    expect(parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'body_json' }).ok).toBe(false);
    expect(parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'path' }).ok).toBe(false);
  });

  it('refuses a base url that is not http', () => {
    expect(parseVaultRoute({ name: 'x', baseUrl: 'api.example.com', authScheme: 'bearer' }).ok).toBe(false);
  });

  it('refuses an unknown scheme and a malformed route key', () => {
    expect(parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'cookie' }).ok).toBe(false);
    expect(
      parseVaultRoute({ name: 'x', baseUrl: 'https://a.test', authScheme: 'bearer', routeKey: 'Has Caps' }).ok
    ).toBe(false);
  });

  it('slugifies a name', () => {
    expect(routeKeySlug('CKFF EU edge')).toBe('ckff-eu-edge');
    expect(routeKeySlug('  ')).toBe('route');
  });
});
