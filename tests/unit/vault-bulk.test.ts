import { describe, expect, it } from 'vitest';
import { inferVaultGroup, inferVaultKind, parseBulkVaultLine } from '../../src/lib/vault-policy';

const WORKSPACE = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

describe('bulk paste lines', () => {
  it('splits LABEL=secret and infers the kind from the label', () => {
    const parsed = parseBulkVaultLine('Cloudflare=cf-token', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        label: 'Cloudflare',
        description: 'Cloudflare',
        kind: 'token',
        kindSource: 'inferred',
        secret: 'cf-token',
        workspaceId: null,
      });
    }
  });

  it('infers url, token and note kinds from the label shape', () => {
    expect(inferVaultKind('OPENROUTER_API_URL', 'https://openrouter.ai/api')).toBe('url');
    expect(inferVaultKind('ckff-api-url', 'https://api.example.com')).toBe('url');
    expect(inferVaultKind('CLOUDFLARE_API_TOKEN', 'cf-token')).toBe('token');
    expect(inferVaultKind('GLM_API_KEY', 'glm-key')).toBe('token');
    expect(inferVaultKind('SUPABASE_PROJECT_REF', 'abc123')).toBe('note');
    expect(inferVaultKind('CKFF_CODEX_MODEL', 'gpt-5')).toBe('note');
    expect(inferVaultKind('LANGFUSE_HOST', 'https://langfuse.example')).toBe('url');
    expect(inferVaultKind('fish_audio_api', 'fa-key')).toBe('token');
  });

  it('infers url from the value when the label is silent', () => {
    expect(inferVaultKind('somewhere', 'https://api.example.com/v1')).toBe('url');
    expect(inferVaultKind('CKFF_CODEX_MODEL', 'gpt-5')).toBe('note');
  });

  it('records an explicit per-line kind override', () => {
    const parsed = parseBulkVaultLine('login:GitHub=ghp_xxx', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kind).toBe('login');
      expect(parsed.value.kindSource).toBe('explicit');
    }
  });

  it('fills the URL column from an address value on a url line', () => {
    const parsed = parseBulkVaultLine('CKFF_API_URL=https://api.example.com', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kind).toBe('url');
      expect(parsed.value.url).toBe('https://api.example.com');
    }
  });

  it('splits on the first separator so a secret may contain "="', () => {
    const parsed = parseBulkVaultLine('Token=abc=def', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.label).toBe('Token');
      expect(parsed.value.secret).toBe('abc=def');
    }
  });

  it('trims surrounding whitespace from both sides', () => {
    const parsed = parseBulkVaultLine('  GitHub = ghp_xxx  ', null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.label).toBe('GitHub');
      expect(parsed.value.secret).toBe('ghp_xxx');
    }
  });

  it('refuses a line with no separator', () => {
    const parsed = parseBulkVaultLine('just-a-label', null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('BULK_LINE');
  });

  it('refuses a missing label or a missing secret', () => {
    expect(parseBulkVaultLine('=secret', null).ok).toBe(false);
    expect(parseBulkVaultLine('label=', null).ok).toBe(false);
  });

  it('groups a label by its service prefix and folds aliases', () => {
    expect(inferVaultGroup('OPENROUTER_API_KEY')).toBe('openrouter');
    expect(inferVaultGroup('ckff-cortex-default-model')).toBe('ckff');
    expect(inferVaultGroup('NEXT_PUBLIC_SUPABASE_URL')).toBe('supabase');
    expect(inferVaultGroup('vast-ai')).toBe('vast');
    expect(inferVaultGroup('GODADDY_ACCOUNT_TOKEN')).toBe('godaddy');
  });
});
