import { describe, expect, it } from 'vitest';
import { checkVaultItem, type HealthProbe } from '../../src/lib/vault-health';
import { UNCHECKED_STALE_MS } from '../../src/lib/vault-policy';

const NOW = Date.parse('2026-10-16T12:00:00Z');

function probeReturning(status: number | 'error'): HealthProbe {
  return async () => status;
}

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
