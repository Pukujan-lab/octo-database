/**
 * Property and metamorphic checks for the vault cabinet.
 *
 * The relations are quantified over a generated set, not one example:
 * a lifetime is accepted exactly on the closed hour range, a decoy stand-in
 * does not change when the stored secret changes, and a description moves
 * with the item on both the real and the decoy payload.
 */

import { describe, expect, it } from 'vitest';
import { checkVaultItem } from '../../src/lib/vault-health';
import {
  GRANT_MAX_HOURS,
  GRANT_MIN_HOURS,
  parseGrantHours,
  presentVaultItem,
  type VaultKind,
} from '../../src/lib/vault-policy';

const GRANT = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

describe('grant lifetime property', () => {
  it('accepts exactly the whole hours from 5 through 72', () => {
    for (let hours = 0; hours <= 80; hours += 1) {
      const parsed = parseGrantHours(hours);
      const inside = hours >= GRANT_MIN_HOURS && hours <= GRANT_MAX_HOURS;
      expect(parsed.ok).toBe(inside);
      if (parsed.ok) expect(parsed.hours).toBe(hours);
    }
  });

  it('treats a fractional hour the same as a refusal, including next to the default', () => {
    for (const hours of [4.9, 5.1, 23.5, 24.5, 71.9, 72.1]) {
      expect(parseGrantHours(hours).ok).toBe(false);
    }
  });
});

describe('decoy metamorphic relation', () => {
  const kinds: VaultKind[] = ['login', 'token', 'url', 'note'];

  it('keeps the decoy stand-in fixed when the stored secret changes', () => {
    const next = xorshift(0xdec0);
    for (const kind of kinds) {
      const firstSecret = `secret-${next().toString(16)}`;
      const secondSecret = `secret-${next().toString(16)}`;
      const base = {
        id: ITEM,
        label: 'Cloudflare',
        description: 'Account token for the zone, not the R2 token.',
        kind,
        username: 'ada',
        url: 'https://api.cloudflare.com/client/v4',
        notes: 'rotated last week',
        healthStatus: 'unchecked',
        grantId: GRANT,
        decoy: true as const,
      };
      const first = presentVaultItem({ ...base, secret: firstSecret });
      const second = presentVaultItem({ ...base, secret: secondSecret });
      expect(first.secret).toBe(second.secret);
      expect(first.secret).not.toBe(firstSecret);
      expect(first.secret).not.toBe(secondSecret);
      expect(first.description).toBe(base.description);
      expect(first.label).toBe(base.label);
    }
  });

  it('moves the description on the real payload and the decoy payload together', () => {
    const next = xorshift(0xbdd);
    for (let i = 0; i < 20; i += 1) {
      const description = `what this password is for ${next().toString(16)}`;
      const secret = `pw-${next().toString(16)}`;
      const shared = {
        id: ITEM,
        label: 'Studio mail',
        description,
        kind: 'login' as const,
        username: 'ada@studio.test',
        url: null,
        secret,
        notes: null,
        healthStatus: 'unchecked',
        grantId: GRANT,
      };
      const real = presentVaultItem({ ...shared, decoy: false });
      const decoy = presentVaultItem({ ...shared, decoy: true });
      expect(real.description).toBe(description);
      expect(decoy.description).toBe(description);
      expect(real.secret).toBe(secret);
      expect(decoy.secret).not.toBe(secret);
    }
  });
});

describe('health metamorphic relation', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');

  it('classifies every rejection status the same, and every success status the same', async () => {
    for (const status of [401, 403]) {
      const verdict = await checkVaultItem(
        { kind: 'token', url: 'https://api.example.com', createdAtMs: now },
        'token',
        async () => status,
        now
      );
      expect(verdict.status).toBe('stale');
    }
    for (const status of [200, 204, 299]) {
      const verdict = await checkVaultItem(
        { kind: 'token', url: 'https://api.example.com', createdAtMs: now },
        'token',
        async () => status,
        now
      );
      expect(verdict.status).toBe('healthy');
    }
  });

  it('leaves a fresh failed check unchecked and marks the same item stale after 30 days', async () => {
    const item = { kind: 'token' as const, url: null, createdAtMs: now };
    const fresh = await checkVaultItem(item, 'token', async () => 'error', now);
    const aged = await checkVaultItem(item, 'token', async () => 'error', now + 30 * 24 * 60 * 60 * 1000);
    expect(fresh.status).toBe('unchecked');
    expect(aged.status).toBe('stale');
  });
});
