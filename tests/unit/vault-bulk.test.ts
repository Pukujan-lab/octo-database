import { describe, expect, it } from 'vitest';
import { parseBulkVaultLine } from '../../src/lib/vault-policy';

const WORKSPACE = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

describe('bulk paste lines', () => {
  it('splits LABEL=secret and keeps the label as the description', () => {
    const parsed = parseBulkVaultLine('Cloudflare=cf-token', 'token', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        label: 'Cloudflare',
        description: 'Cloudflare',
        kind: 'token',
        secret: 'cf-token',
        workspaceId: null,
      });
    }
  });

  it('splits on the first separator so a secret may contain "="', () => {
    const parsed = parseBulkVaultLine('Token=abc=def', 'token', WORKSPACE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.label).toBe('Token');
      expect(parsed.value.secret).toBe('abc=def');
      expect(parsed.value.workspaceId).toBe(WORKSPACE);
    }
  });

  it('trims surrounding whitespace from both sides', () => {
    const parsed = parseBulkVaultLine('  GitHub = ghp_xxx  ', 'token', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.label).toBe('GitHub');
      expect(parsed.value.secret).toBe('ghp_xxx');
    }
  });

  it('refuses a line with no separator', () => {
    const parsed = parseBulkVaultLine('just-a-label', 'token', null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('BULK_LINE');
  });

  it('refuses a missing label or a missing secret', () => {
    expect(parseBulkVaultLine('=secret', 'token', null).ok).toBe(false);
    expect(parseBulkVaultLine('label=', 'token', null).ok).toBe(false);
  });

  it('refuses an unknown kind through the shared item parser', () => {
    const parsed = parseBulkVaultLine('Label=secret', 'certificate' as 'token', null);
    expect(parsed.ok).toBe(false);
  });
});
