import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/db', () => ({
  bindRequestIdentity: vi.fn(),
  dbGetWorkspaceMembership: vi.fn(),
  dbResolveShareById: vi.fn(),
  dbVerifyApiKey: vi.fn(async () => ({
    keyId: 'key-owner-agent',
    principalId: 'p1',
    prefix: 'octo_live_acc',
    keyName: 'agents',
    workspaceId: null,
    role: 'owner',
    scopes: ['read', 'write'],
  })),
  queryService: vi.fn(async () => [
    { id: 'p1', auth_user_id: 'u1', email: 'owner@example.com', display_name: null, avatar_url: null, is_guest: false, is_platform_owner: true },
  ]),
  dbConsumeMfaRecoveryCode: vi.fn(),
  dbGetConfirmSecretHash: vi.fn(),
  dbGetMfa: vi.fn(),
}));

import { authenticateRequest } from '../../src/server/auth-context';
import { confirmGate } from '../../src/server/confirm';

const request = { headers: { authorization: 'Bearer octo_live_acc_secret' } } as never;

describe('owner agent keys', () => {
  afterEach(() => {
    delete process.env['OCTO_OWNER_AGENT_KEYS'];
  });

  it('an unlisted key stays an API key and cannot confirm', async () => {
    const auth = await authenticateRequest(request);
    expect(auth?.apiKey?.keyId).toBe('key-owner-agent');
    expect(auth?.ownerAgent).toBeUndefined();
    const res = { writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn() } as never;
    expect(await confirmGate(res, auth!, undefined)).toBe(false);
  });

  it('a listed account-wide key acts as the owner session and confirms', async () => {
    process.env['OCTO_OWNER_AGENT_KEYS'] = 'other, key-owner-agent';
    const auth = await authenticateRequest(request);
    expect(auth?.apiKey).toBeUndefined();
    expect(auth?.ownerAgent).toBe(true);
    expect(auth?.principal.id).toBe('p1');
    expect(await confirmGate({} as never, auth!, undefined, { requireMfa: true })).toBe(true);
  });
});
