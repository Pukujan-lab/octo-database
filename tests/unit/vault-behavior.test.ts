/**
 * Behavior scenarios for the cabinet an agent pastes a grant into.
 *
 * Given / When / Then, against the rules the dashboard and the open route share.
 */

import { describe, expect, it } from 'vitest';
import { parseGrantHours, parseVaultItem, presentVaultItem } from '../../src/lib/vault-policy';

const WORKSPACE = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

describe('storing a key', () => {
  it('given a token with a description, when it is saved, then the description is kept', () => {
    const parsed = parseVaultItem(
      {
        label: 'Cloudflare',
        description: 'Account token for the gravebuster zone. Not the R2 token.',
        kind: 'token',
        secret: 'cf-real',
        url: 'https://api.cloudflare.com/client/v4',
      },
      null
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.description).toBe('Account token for the gravebuster zone. Not the R2 token.');
      expect(parsed.value.workspaceId).toBeNull();
    }
  });

  it('given a password with a description, when it is saved on a workspace, then both are kept', () => {
    const parsed = parseVaultItem(
      {
        label: 'Studio mail',
        description: 'The mailbox password for the studio admin login.',
        kind: 'login',
        username: 'ada@studio.test',
        secret: 'correct-horse',
      },
      WORKSPACE
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kind).toBe('login');
      expect(parsed.value.description).toContain('mailbox password');
      expect(parsed.value.workspaceId).toBe(WORKSPACE);
    }
  });

  it('given a token with no description, when it is saved, then it is refused', () => {
    const parsed = parseVaultItem({ label: 'Cloudflare', kind: 'token', secret: 'cf-real' }, null);
    expect(parsed.ok).toBe(false);
  });

  it('given a password with no description, when it is saved, then it is refused', () => {
    const parsed = parseVaultItem({ label: 'Studio mail', kind: 'login', secret: 'hunter2' }, null);
    expect(parsed.ok).toBe(false);
  });
});

describe('handing a grant to an agent', () => {
  it('given no lifetime, when a grant is minted, then it lasts 24 hours', () => {
    expect(parseGrantHours(undefined)).toEqual({ ok: true, hours: 24 });
  });

  it('given 5, 10, or 72 hours, when a grant is minted, then that lifetime is accepted', () => {
    expect(parseGrantHours(5)).toEqual({ ok: true, hours: 5 });
    expect(parseGrantHours(10)).toEqual({ ok: true, hours: 10 });
    expect(parseGrantHours(72)).toEqual({ ok: true, hours: 72 });
  });

  it('given 4 or 73 hours, when a grant is minted, then it is refused', () => {
    expect(parseGrantHours(4).ok).toBe(false);
    expect(parseGrantHours(73).ok).toBe(false);
  });

  it('given a real grant, when the agent opens the cabinet, then it receives the password and the description', () => {
    const opened = presentVaultItem({
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Studio mail',
      description: 'The mailbox password for the studio admin login.',
      kind: 'login',
      username: 'ada@studio.test',
      url: null,
      secret: 'correct-horse',
      notes: null,
      healthStatus: 'unchecked',
      grantId: '11111111-1111-4111-8111-111111111111',
      decoy: false,
    });
    expect(opened.secret).toBe('correct-horse');
    expect(opened.description).toBe('The mailbox password for the studio admin login.');
  });

  it('given a decoy grant, when the agent opens the cabinet, then the description matches and the password does not', () => {
    const opened = presentVaultItem({
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Studio mail',
      description: 'The mailbox password for the studio admin login.',
      kind: 'login',
      username: 'ada@studio.test',
      url: null,
      secret: 'correct-horse',
      notes: null,
      healthStatus: 'unchecked',
      grantId: '11111111-1111-4111-8111-111111111111',
      decoy: true,
    });
    expect(opened.description).toBe('The mailbox password for the studio admin login.');
    expect(opened.secret).not.toBe('correct-horse');
    expect(JSON.stringify(opened).toLowerCase()).not.toContain('decoy');
  });
});
