/**
 * Unit Tests: Agent capability discovery and scope model (Slice 7)
 */

import { describe, expect, it } from 'vitest';
import {
  AUTH_GUIDANCE,
  capabilitiesForScopes,
  hasScope,
  KEY_CLASSES,
  minimumRoleForCapability,
  OCTO_CAPABILITIES,
  SCOPE_PRESETS,
} from '../../src/api/capabilities';

describe('Capability discovery', () => {
  it('offers a stable, non-empty surface', () => {
    expect(OCTO_CAPABILITIES.length).toBeGreaterThan(0);
    const actions = OCTO_CAPABILITIES.map((c) => c.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('filters capabilities to the granted scopes', () => {
    const readOnly = capabilitiesForScopes(['read']);
    // A read-only token sees only read-scoped capabilities.
    expect(readOnly.every((c) => c.requiredScope === 'read')).toBe(true);
    expect(readOnly.some((c) => c.action === 'workspaces.list')).toBe(true);
    expect(readOnly.some((c) => c.action === 'files.delete')).toBe(false);

    const full = capabilitiesForScopes(['read', 'write', 'delete', 'files']);
    expect(full.some((c) => c.action === 'files.delete')).toBe(true);
    expect(full.some((c) => c.action === 'files.upload')).toBe(true);
  });

  it('never exposes a destructive action to a token without the delete scope', () => {
    for (const scopes of [['read'], ['files'], ['read', 'files'], ['read', 'write', 'files']]) {
      const caps = capabilitiesForScopes(scopes);
      expect(caps.some((c) => c.requiredScope === 'delete')).toBe(false);
    }
  });

  it('enforces scope membership', () => {
    expect(hasScope(['read', 'files'], 'files')).toBe(true);
    expect(hasScope(['read'], 'delete')).toBe(false);
    expect(hasScope([], 'read')).toBe(false);
  });

  it('describes authentication without disclosing any credential', () => {
    const serialized = JSON.stringify(AUTH_GUIDANCE);
    expect(serialized).toContain('Bearer');
    // No provider, database, or infrastructure secret shape appears.
    expect(serialized).not.toMatch(/CLOUDFLARE_SECRET|SERVICE_ROLE|password|refresh_token/i);
  });

  it('advertises workspace create and the archive/restore transitions', () => {
    const byAction = new Map(OCTO_CAPABILITIES.map((c) => [c.action, c]));
    expect(byAction.get('workspaces.create')?.requiredScope).toBe('write');
    expect(byAction.get('workspaces.provision_database')?.requiredScope).toBe('write');
    expect(byAction.get('workspaces.query')?.requiredScope).toBe('read');
    expect(byAction.get('files.publish')?.requiredScope).toBe('write');
    expect(byAction.get('files.publish')?.method).toBe('POST');
    expect(byAction.get('files.unpublish')?.requiredScope).toBe('write');
    expect(byAction.get('files.unpublish')?.method).toBe('POST');
    expect(byAction.get('files.archive')?.requiredScope).toBe('delete');
    expect(byAction.get('files.restore')?.requiredScope).toBe('write');
    expect(byAction.get('activity.list')?.requiredScope).toBe('read');
    expect(byAction.get('ops.list')?.requiredScope).toBe('read');
    expect(byAction.get('ops.summary')?.requiredScope).toBe('read');
    expect(byAction.get('graph.query')?.requiredScope).toBe('read');
    expect(byAction.get('keys.revoke')?.requiredScope).toBe('delete');
    expect(minimumRoleForCapability('files.publish')).toBe('operator');
    expect(minimumRoleForCapability('files.unpublish')).toBe('operator');
    expect(byAction.get('rag.list')?.requiredScope).toBe('read');
    expect(byAction.get('rag.get')?.requiredScope).toBe('read');
    expect(byAction.get('rag.ingest')?.requiredScope).toBe('write');
    expect(byAction.get('rag.rename')?.requiredScope).toBe('write');
    expect(byAction.get('rag.delete')?.requiredScope).toBe('delete');
    expect(byAction.get('rag.delete')?.method).toBe('DELETE');
    expect(minimumRoleForCapability('rag.rename')).toBe('operator');
    expect(minimumRoleForCapability('rag.delete')).toBe('admin');

    const program = capabilitiesForScopes(['read', 'write', 'files']);
    expect(program.some((c) => c.action === 'files.publish')).toBe(true);
    expect(program.some((c) => c.action === 'files.unpublish')).toBe(true);
    for (const scopes of [['read', 'files'], ['read']] as const) {
      const caps = capabilitiesForScopes([...scopes]);
      expect(caps.some((c) => c.action === 'files.publish')).toBe(false);
      expect(caps.some((c) => c.action === 'files.unpublish')).toBe(false);
    }
    const withoutDelete = capabilitiesForScopes(['read', 'write', 'files']);
    expect(withoutDelete.some((c) => c.action === 'files.publish')).toBe(true);
    expect(withoutDelete.some((c) => c.requiredScope === 'delete')).toBe(false);
  });

  it('records the provisioned-database exception without disclosing a credential', () => {
    // The one documented exception to "tokens never expose a database credential":
    // the note must name it, and must still carry no secret-shaped value. The
    // `octo_live_...` bearer placeholder is the documented token shape, not a secret.
    expect(AUTH_GUIDANCE.note).toMatch(/provisioned workspace/i);
    const serialized = JSON.stringify(AUTH_GUIDANCE);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/password|secret/i);
  });

  it('defines key classes as profiles over real scopes, none destructive', () => {
    const realScopes = new Set(OCTO_CAPABILITIES.map((c) => c.requiredScope));
    const classes = Object.entries(KEY_CLASSES);
    expect(classes.length).toBeGreaterThan(0);
    for (const [, profile] of classes) {
      expect(profile.label.length).toBeGreaterThan(0);
      // Every class carries a documented authority profile...
      expect(profile.description.length).toBeGreaterThan(0);
      // ...mapped only onto scopes that a route actually enforces...
      expect(profile.scopes.length).toBeGreaterThan(0);
      for (const scope of profile.scopes) expect(realScopes.has(scope)).toBe(true);
      // ...and no class grants destructive authority.
      expect(profile.scopes).not.toContain('delete');
    }
  });

  it('no longer offers an inert admin scope', () => {
    // `admin` was accepted at mint time but enforced nowhere; it is removed, so it
    // must appear in no scope list, no capability, and no class.
    const allScopes = [
      ...OCTO_CAPABILITIES.map((c) => c.requiredScope),
      ...SCOPE_PRESETS.flatMap((p) => p.scopes),
      ...Object.values(KEY_CLASSES).flatMap((p) => [...p.scopes]),
    ];
    expect(allScopes).not.toContain('admin' as never);
  });

  it('defines presets that map only onto real scopes', () => {
    const realScopes = new Set(OCTO_CAPABILITIES.map((c) => c.requiredScope));
    expect(SCOPE_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SCOPE_PRESETS) {
      expect(preset.scopes.length).toBeGreaterThan(0);
      for (const scope of preset.scopes) {
        expect(realScopes.has(scope)).toBe(true);
      }
    }
    // The Full preset is the only one that grants destructive authority.
    const withDelete = SCOPE_PRESETS.filter((p) => p.scopes.includes('delete'));
    expect(withDelete.map((p) => p.id)).toEqual(['full']);
  });
});
