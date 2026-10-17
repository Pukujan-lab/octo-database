import { describe, expect, it } from 'vitest';
import { decoyField, GRANT_DEFAULT_HOURS, parseGrantHours, parseVaultItem } from '../../src/lib/vault-policy';

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

describe('decoy fields', () => {
  const grant = '11111111-1111-4111-8111-111111111111';
  const item = '22222222-2222-4222-8222-222222222222';

  it('is stable and is not the stored secret', () => {
    const first = decoyField(grant, item, 'secret', 'token');
    const second = decoyField(grant, item, 'secret', 'token');
    expect(first).toBe(second);
    expect(first).not.toBe('cf-real-token-value');
    expect(first.toLowerCase()).not.toContain('decoy');
  });

  it('changes when the grant changes', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect(decoyField(grant, item, 'secret', 'token')).not.toBe(decoyField(other, item, 'secret', 'token'));
  });

  it('replaces a stored url with a reserved host', () => {
    const url = decoyField(grant, item, 'secret', 'url');
    expect(url.startsWith('https://example.invalid/')).toBe(true);
    expect(url).not.toContain('files.example.com');
  });
});
