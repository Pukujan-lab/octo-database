import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  verified: null as null | Record<string, unknown>,
  dead: null as null | Record<string, unknown>,
  use: { newIp: false, firstAlertThisHour: true },
}));

vi.mock('../../src/server/db', () => ({
  bindRequestIdentity: vi.fn(),
  dbGetWorkspaceMembership: vi.fn(),
  dbResolveShareById: vi.fn(),
  dbVerifyApiKey: vi.fn(async () => db.verified),
  dbFindDeadApiKey: vi.fn(async () => db.dead),
  dbRecordKeyUse: vi.fn(async () => db.use),
  queryService: vi.fn(async () => [
    { id: 'p1', auth_user_id: 'u1', email: 'o@example.com', display_name: null, avatar_url: null, is_guest: false, is_platform_owner: false },
  ]),
}));

import { authenticateRequest } from '../../src/server/auth-context';
import { dbRecordKeyUse } from '../../src/server/db';

const req = {
  method: 'GET',
  url: '/api/me?x=1',
  headers: { authorization: 'Bearer octo_live_abc_secret', 'x-forwarded-for': '203.0.113.7, 172.21.0.3' },
  socket: { remoteAddress: '172.21.0.3' },
} as never;

const fetchMock = vi.fn(async () => new Response('ok'));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('key use log and leak alerts (#362)', () => {
  beforeEach(() => {
    process.env['NTFY_TOPIC'] = 'test-topic';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    vi.mocked(dbRecordKeyUse).mockClear();
    db.verified = null;
    db.dead = null;
    db.use = { newIp: false, firstAlertThisHour: true };
  });
  afterEach(() => {
    delete process.env['NTFY_TOPIC'];
    vi.unstubAllGlobals();
  });

  it('logs a use with the forwarded client IP and no query string, and stays quiet', async () => {
    db.verified = { keyId: 'k1', prefix: 'octo_live_abc', keyName: 'ci', principalId: 'p1', workspaceId: null, role: null, scopes: ['read'] };
    expect(await authenticateRequest(req)).not.toBeNull();
    await settle();
    expect(dbRecordKeyUse).toHaveBeenCalledWith('k1', 'p1', '203.0.113.7', 'GET', '/api/me', 'ok');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('alerts when an established key shows up from a new IP', async () => {
    db.verified = { keyId: 'k1', prefix: 'octo_live_abc', keyName: 'ci', principalId: 'p1', workspaceId: null, role: null, scopes: ['read'] };
    db.use = { newIp: true, firstAlertThisHour: true };
    await authenticateRequest(req);
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh/test-topic');
    expect(String(init.body)).toContain('203.0.113.7');
    expect(String(init.body)).not.toContain('secret');
  });

  it('refuses a revoked key, logs it and alerts once an hour', async () => {
    db.dead = { keyId: 'k2', prefix: 'octo_live_old', principalId: 'p1', outcome: 'revoked' };
    expect(await authenticateRequest(req)).toBeNull();
    await settle();
    expect(dbRecordKeyUse).toHaveBeenCalledWith('k2', 'p1', '203.0.113.7', 'GET', '/api/me', 'revoked');
    expect(fetchMock).toHaveBeenCalledOnce();

    db.use = { newIp: false, firstAlertThisHour: false };
    await authenticateRequest(req);
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does nothing for an unknown string', async () => {
    expect(await authenticateRequest(req)).toBeNull();
    await settle();
    expect(dbRecordKeyUse).not.toHaveBeenCalled();
  });
});
