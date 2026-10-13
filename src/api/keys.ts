/**
 * Octo API Key Engine (Slice 7 / Issue #9)
 *
 * Manages account-wide and workspace-scoped machine identities.
 * Stores cryptographically secure SHA-256 hashes; secrets are never stored in plaintext.
 */

import { randomBytes } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { Principal, WorkspaceRole } from '../types/auth';
import { hashApiKeySecret } from '../lib/secret-hash';

// The implementation lives in src/lib/secret-hash.ts so that leaf lib modules can
// hash secrets without reaching up into src/api; re-exported here for compatibility.
export { hashApiKeySecret };

export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  principalId: string;
  workspaceId: string | null; // null = Account-wide
  workspaceName?: string | null;
  role: WorkspaceRole | null;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  isAccountWide: boolean;
}

export interface CreateApiKeyInput {
  name: string;
  workspaceId?: string | null; // Omit or null for account-wide key
  role?: WorkspaceRole;
  scopes?: string[];
  expiresInDays?: number;
}

export interface CreatedApiKeyResult {
  apiKey: ApiKey;
  rawSecret: string;
}

/** The minting caller's own authority, reduced to what the decision depends on. */
export interface KeyMintCaller {
  isApiKey: boolean;
  /** Caller's workspace binding; null means account-wide (or a human session). */
  workspaceId: string | null;
  scopes: string[];
}

export interface KeyMintRequest {
  workspaceId: string | null;
  scopes: string[];
}

export type KeyMintDecision =
  | { ok: true; workspaceId: string | null; scopes: string[] }
  | { ok: false; status: number; error: string };

/**
 * Authorizes an API-key caller minting another key. A token may only ever narrow
 * its own authority: it must hold the write scope, it may never mint an
 * account-wide key or escape its workspace binding, and it may not grant a scope
 * it does not itself hold. Human sessions are not constrained here; the route
 * applies its own membership checks.
 */
export function authorizeKeyMint(caller: KeyMintCaller, request: KeyMintRequest): KeyMintDecision {
  if (!caller.isApiKey) {
    return { ok: true, workspaceId: request.workspaceId, scopes: request.scopes };
  }

  if (!caller.scopes.includes('write')) {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN: Token is missing the required 'write' scope",
    };
  }

  if (caller.workspaceId !== null && request.workspaceId !== caller.workspaceId) {
    return {
      ok: false,
      status: 403,
      error: 'FORBIDDEN: A workspace-bound key may only mint keys bound to its own workspace',
    };
  }

  const widened = request.scopes.filter((scope) => !caller.scopes.includes(scope));
  if (widened.length > 0) {
    return {
      ok: false,
      status: 403,
      error: `FORBIDDEN: Cannot grant scopes the token does not hold: ${widened.join(', ')}`,
    };
  }

  return { ok: true, workspaceId: request.workspaceId, scopes: request.scopes };
}

/** The allowances a key can hold. Routes check these, not finer capability names. */
export const KEY_SCOPE_VALUES = ['read', 'write', 'files', 'delete'] as const;

/**
 * Accepts an explicit allowance list. Empty and unknown values are refused.
 * Duplicates collapse so a repeated checkbox cannot store the same scope twice.
 */
export function parseKeyScopes(
  requested: unknown
): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, error: 'BAD_REQUEST: scopes must be a non-empty array' };
  }
  const unknown = requested.filter(
    (scope) => typeof scope !== 'string' || !(KEY_SCOPE_VALUES as readonly string[]).includes(scope)
  );
  if (unknown.length > 0) {
    return { ok: false, error: `BAD_REQUEST: unknown scopes: ${unknown.join(', ')}` };
  }
  const scopes: string[] = [];
  for (const scope of requested as string[]) {
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return { ok: true, scopes };
}

/**
 * Creates a new API key (either account-wide or workspace-scoped).
 * Returns the raw secret exactly once.
 */
export async function createApiKey(
  supabase: SupabaseClient,
  principal: Principal,
  input: CreateApiKeyInput
): Promise<CreatedApiKeyResult> {
  const isAccountWide = !input.workspaceId;
  const prefix = isAccountWide ? 'octo_live_acc' : 'octo_live_ws';
  const secretBytes = randomBytes(24).toString('hex');
  const rawSecret = `${prefix}_${secretBytes}`;
  const keyHash = hashApiKeySecret(rawSecret);

  let expiresAt: string | null = null;
  if (input.expiresInDays && input.expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + input.expiresInDays);
    expiresAt = d.toISOString();
  }

  const scopes = input.scopes ?? ['read', 'write'];
  const now = new Date().toISOString();

  const row = {
    key_hash: keyHash,
    prefix,
    name: input.name.trim(),
    principal_id: principal.id,
    workspace_id: input.workspaceId ?? null,
    role: input.role ?? (isAccountWide ? 'owner' : 'member'),
    scopes,
    expires_at: expiresAt,
    created_at: now,
  };

  const { data: inserted, error } = await supabase
    .schema('octo')
    .from('api_keys')
    .insert(row)
    .select('*')
    .single();

  if (error || !inserted) {
    throw new Error(`API_KEY_CREATE_FAILED: ${error?.message ?? 'Unknown error'}`);
  }

  const apiKey = mapApiKeyRow(inserted);

  return {
    apiKey,
    rawSecret,
  };
}

/**
 * Lists all API keys belonging to the current authenticated user.
 */
export async function listApiKeys(supabase: SupabaseClient): Promise<ApiKey[]> {
  const { data, error } = await supabase
    .schema('octo')
    .from('api_keys')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`LIST_API_KEYS_FAILED: ${error.message}`);
  }

  if (!data) return [];
  return data.map(mapApiKeyRow);
}

/**
 * Revokes (deletes) an API key.
 */
export async function revokeApiKey(
  supabase: SupabaseClient,
  apiKeyId: string
): Promise<void> {
  const { error } = await supabase
    .schema('octo')
    .from('api_keys')
    .delete()
    .eq('id', apiKeyId);

  if (error) {
    throw new Error(`REVOKE_API_KEY_FAILED: ${error.message}`);
  }
}

interface RawApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  principal_id: string;
  workspace_id: string | null;
  role: WorkspaceRole | null;
  scopes: string[];
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

function mapApiKeyRow(row: unknown): ApiKey {
  const r = row as RawApiKeyRow;
  return {
    id: r.id,
    prefix: r.prefix,
    name: r.name,
    principalId: r.principal_id,
    workspaceId: r.workspace_id,
    role: r.role,
    scopes: r.scopes ?? ['read', 'write'],
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    isAccountWide: r.workspace_id === null,
  };
}
