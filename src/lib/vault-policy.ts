/**
 * Rules for the password-manager cabinet and the temporary grant handed to an
 * agent. Lifetimes and item shape live here so the route and the tests share
 * one definition.
 */

import { createHmac } from 'node:crypto';

export const VAULT_KINDS = ['login', 'token', 'url', 'note'] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/** Default grant lifetime. Chosen even though it is not a 5-hour step. */
export const GRANT_DEFAULT_HOURS = 24;
export const GRANT_MIN_HOURS = 5;
/** Three days. */
export const GRANT_MAX_HOURS = 72;

/** An item that cannot be checked becomes stale after this long. */
export const UNCHECKED_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** A stale item is removed on the next health pass after this long. */
export const STALE_PURGE_MS = 14 * 24 * 60 * 60 * 1000;

const LABEL_MAX = 200;
const FIELD_MAX = 2000;
const SECRET_MAX = 8000;

export interface VaultItemInput {
  label: string;
  description: string;
  kind: VaultKind;
  username: string | null;
  url: string | null;
  secret: string | null;
  notes: string | null;
  workspaceId: string | null;
}

export function parseGrantHours(input: unknown): { ok: true; hours: number } | { ok: false; error: string } {
  if (input === undefined || input === null || input === '') {
    return { ok: true, hours: GRANT_DEFAULT_HOURS };
  }
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input.trim()) : Number.NaN;
  if (!Number.isInteger(value) || value < GRANT_MIN_HOURS || value > GRANT_MAX_HOURS) {
    return {
      ok: false,
      error: `GRANT_HOURS: lifetime must be a whole number of hours from ${GRANT_MIN_HOURS} through ${GRANT_MAX_HOURS}.`,
    };
  }
  return { ok: true, hours: value };
}

export function grantExpiresAt(hours: number, now = Date.now()): string {
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}

function optionalText(value: unknown, max: number, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${field} must be text.` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: `${field} is too long.` };
  return { ok: true, value: trimmed };
}

export function parseVaultItem(
  body: Record<string, unknown>,
  workspaceId: string | null
): { ok: true; value: VaultItemInput } | { ok: false; error: string } {
  const label = optionalText(body['label'], LABEL_MAX, 'label');
  if (!label.ok) return label;
  if (!label.value) return { ok: false, error: 'LABEL_REQUIRED: name the item.' };

  const kindRaw = body['kind'];
  if (typeof kindRaw !== 'string' || !VAULT_KINDS.includes(kindRaw as VaultKind)) {
    return { ok: false, error: 'KIND_INVALID: kind must be login, token, url, or note.' };
  }
  const kind = kindRaw as VaultKind;

  const description = optionalText(body['description'], FIELD_MAX, 'description');
  if (!description.ok) return description;
  if (!description.value) {
    return { ok: false, error: 'DESCRIPTION_REQUIRED: say what this item is for so an agent can tell it apart.' };
  }

  const username = optionalText(body['username'], LABEL_MAX, 'username');
  if (!username.ok) return username;
  const url = optionalText(body['url'], FIELD_MAX, 'url');
  if (!url.ok) return url;
  if (url.value && !/^https?:\/\//i.test(url.value)) {
    return { ok: false, error: 'URL_INVALID: url must start with http:// or https://.' };
  }
  const secret = optionalText(body['secret'], SECRET_MAX, 'secret');
  if (!secret.ok) return secret;
  const notes = optionalText(body['notes'], SECRET_MAX, 'notes');
  if (!notes.ok) return notes;

  if (!secret.value && !notes.value && !username.value) {
    return { ok: false, error: 'ITEM_EMPTY: add a secret, a username, or a note.' };
  }

  return {
    ok: true,
    value: {
      label: label.value,
      description: description.value,
      kind,
      username: username.value,
      url: url.value,
      secret: secret.value,
      notes: notes.value,
      workspaceId,
    },
  };
}

export const BULK_MAX_LINES = 200;

/**
 * Parses one `LABEL=secret` line for the dashboard's paste-many import. The
 * label keeps everything before the first `=` (so `a=b=c` splits label `a`,
 * secret `b=c`), whitespace is trimmed, and a line with no separator or no
 * content on either side is refused with the 1-based line number in the
 * message. The caller supplies the batch-wide kind and workspace.
 */
export function parseBulkVaultLine(
  line: string,
  kind: VaultKind,
  workspaceId: string | null
): { ok: true; value: VaultItemInput } | { ok: false; error: string } {
  const sep = line.indexOf('=');
  if (sep === -1) {
    return { ok: false, error: 'BULK_LINE: each line must be LABEL=secret.' };
  }
  const label = line.slice(0, sep).trim();
  const secret = line.slice(sep + 1).trim();
  if (!label || !secret) {
    return { ok: false, error: 'BULK_LINE: each line must be LABEL=secret.' };
  }
  return parseVaultItem(
    { label, description: label, kind, secret },
    workspaceId
  );
}

export interface PresentedVaultItem {
  id: string;
  label: string;
  description: string;
  kind: VaultKind;
  username: string | null;
  url: string | null;
  secret: string | null;
  notes: string | null;
  healthStatus: string;
}

/**
 * The payload an agent receives. A decoy keeps the label and the description
 * (so the agent still knows which item it is) and replaces the secret, the
 * username, and the notes. The stored secret is not an input to the stand-in.
 */
export function presentVaultItem(input: PresentedVaultItem & { grantId: string; decoy: boolean }): PresentedVaultItem {
  if (!input.decoy) {
    return {
      id: input.id,
      label: input.label,
      description: input.description,
      kind: input.kind,
      username: input.username,
      url: input.url,
      secret: input.secret,
      notes: input.notes,
      healthStatus: input.healthStatus,
    };
  }
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    kind: input.kind,
    username: input.username ? decoyField(input.grantId, input.id, 'username', input.kind) : null,
    url: input.kind === 'url' && input.url ? decoyField(input.grantId, input.id, 'secret', 'url') : input.url,
    secret: input.secret ? decoyField(input.grantId, input.id, 'secret', input.kind) : null,
    notes: input.notes ? decoyField(input.grantId, input.id, 'notes', input.kind) : null,
    healthStatus: input.healthStatus,
  };
}

/**
 * Stand-in for one field of one item, stable for a grant. The stored secret is
 * not an input, so the result cannot be the real value. Nothing in the string
 * says "decoy": the agent-facing payload has the same shape as a real open.
 */
export function decoyField(grantId: string, itemId: string, field: 'secret' | 'username' | 'notes', kind: VaultKind): string {
  const mac = createHmac('sha256', 'octo-vault-decoy-v1')
    .update(grantId)
    .update('\0')
    .update(itemId)
    .update('\0')
    .update(field)
    .digest('base64url');
  if (field === 'secret' && kind === 'url') return `https://example.invalid/v/${mac.slice(0, 24)}`;
  if (field === 'username') return `user_${mac.slice(0, 12)}`;
  if (field === 'notes') return mac.slice(0, 24);
  return mac.slice(0, 43);
}
