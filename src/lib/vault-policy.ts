/**
 * Rules for the password-manager cabinet and the temporary grant handed to an
 * agent. Lifetimes and item shape live here so the route and the tests share
 * one definition.
 */

export const VAULT_KINDS = ['login', 'token', 'url', 'note'] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/** What a stored URL actually points at. A docs link is not an API base. */
export const URL_KINDS = ['api_base', 'api_endpoint', 'docs', 'console', 'cors', 's3_endpoint'] as const;
export type UrlKind = (typeof URL_KINDS)[number];

/** Default grant lifetime. Chosen even though it is not a 5-hour step. */
export const GRANT_DEFAULT_HOURS = 24;
export const GRANT_MIN_HOURS = 5;
/** Three days. */
export const GRANT_MAX_HOURS = 72;

/** A working key is long enough to attach to a deployed program. */
export const LEASE_DEFAULT_DAYS = 15;
export const LEASE_MIN_DAYS = 1;
export const LEASE_MAX_DAYS = 30;

/**
 * How a vendor accepts its key. `body_json` rewrites a leaf in the request
 * body (Tavily); `path` substitutes a path segment (Telegram's bot<token>);
 * `query` sets a query parameter.
 */
export const ROUTE_AUTH_SCHEMES = ['bearer', 'x-api-key', 'basic', 'query', 'body_json', 'path'] as const;
export type RouteAuthScheme = (typeof ROUTE_AUTH_SCHEMES)[number];

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
  kindSource: 'explicit' | 'inferred';
  username: string | null;
  url: string | null;
  urlKind: UrlKind | null;
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

export function parseLeaseDays(input: unknown): { ok: true; days: number } | { ok: false; error: string } {
  if (input === undefined || input === null || input === '') {
    return { ok: true, days: LEASE_DEFAULT_DAYS };
  }
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input.trim()) : Number.NaN;
  if (!Number.isInteger(value) || value < LEASE_MIN_DAYS || value > LEASE_MAX_DAYS) {
    return {
      ok: false,
      error: `LEASE_DAYS: lifetime must be a whole number of days from ${LEASE_MIN_DAYS} through ${LEASE_MAX_DAYS}.`,
    };
  }
  return { ok: true, days: value };
}

export function leaseExpiresAt(days: number, now = Date.now()): string {
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
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

  const urlKind = parseUrlKind(body['urlKind'], kind);
  if (!urlKind.ok) return urlKind;

  if (!secret.value && !notes.value && !username.value) {
    return { ok: false, error: 'ITEM_EMPTY: add a secret, a username, or a note.' };
  }

  return {
    ok: true,
    value: {
      label: label.value,
      description: description.value,
      kind,
      kindSource: 'explicit',
      username: username.value,
      url: url.value,
      urlKind: urlKind.value,
      secret: secret.value,
      notes: notes.value,
      workspaceId,
    },
  };
}

/**
 * What a `.env`-style label says it holds, or null when the label carries no
 * signal. An imported paste is one `KIND=value` batch with no per-line
 * selector, so the label decides: names that end in URL/ENDPOINT/HOST are
 * addresses, names that end in KEY/TOKEN/SECRET/PASSWORD are credentials,
 * names that end in MODEL/MODE/ID/NAME/USER are plain config values. A
 * secret that is itself an http(s) string confirms the address reading.
 */
export function inferVaultKind(label: string, secret: string): VaultKind | null {
  const name = label.toLowerCase();
  if (/(^|[_-])(url|uri|endpoint|host|host_lan|base_url|api_url|api_base|api_bases)$/.test(name)) {
    return 'url';
  }
  if (/(^|[_-])(key|token|secret|password|passwd|pwd|bearer|hash|connection_string|access_key|access_key_id|key_id|api)$/.test(name)) {
    return 'token';
  }
  if (/(^|[_-])(model|mode|name|user|username|id|ref|bucket|seconds|timeout|prefix|cmd|exe|origins|store|tier|disabled|required|tasks|workspace|config|ssh)$/.test(name)) {
    return 'note';
  }
  if (/^https?:\/\//i.test(secret)) return 'url';
  return null;
}

/**
 * The service a label belongs to: the prefix before its first field name.
 * Aliases that name the same service are folded together so one vendor does
 * not appear twice in the group rail.
 */
export function inferVaultGroup(label: string): string {
  const cleaned = label.replace(/^next_public_/i, '').toLowerCase();
  const cut = cleaned.search(/[_-]/);
  const group = (cut === -1 ? cleaned : cleaned.slice(0, cut)).trim() || cleaned;
  const aliases: Record<string, string> = {
    octodb: 'octo',
    vastai: 'vast',
    'ckff-cortex': 'ckff',
  };
  return aliases[group] ?? group;
}

/** Only a `url` item carries a url kind; anywhere else it is dropped. */
export function parseUrlKind(
  input: unknown,
  kind: VaultKind
): { ok: true; value: UrlKind | null } | { ok: false; error: string } {
  if (kind !== 'url') return { ok: true, value: null };
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  if (typeof input !== 'string' || !URL_KINDS.includes(input as UrlKind)) {
    return { ok: false, error: 'URL_KIND_INVALID: urlKind must be api_base, api_endpoint, docs, console, cors, or s3_endpoint.' };
  }
  return { ok: true, value: input as UrlKind };
}

export interface VaultRouteInput {
  routeKey: string | null;
  name: string;
  baseUrl: string;
  authScheme: RouteAuthScheme;
  authHeader: string | null;
  bodyField: string | null;
  basicUsername: string | null;
}

/**
 * One vendor-facing base URL for a stored credential. `bodyField` is the JSON
 * leaf for `body_json` and the path template for `path` (a segment containing
 * `{key}`, e.g. `bot{key}/getMe`). A missing `routeKey` is derived from the
 * name by the caller.
 */
export function parseVaultRoute(
  body: Record<string, unknown>
): { ok: true; value: VaultRouteInput } | { ok: false; error: string } {
  const name = optionalText(body['name'], LABEL_MAX, 'name');
  if (!name.ok) return name;
  if (!name.value) return { ok: false, error: 'ROUTE_NAME_REQUIRED: name the route.' };

  const baseUrl = optionalText(body['baseUrl'], FIELD_MAX, 'baseUrl');
  if (!baseUrl.ok) return baseUrl;
  if (!baseUrl.value || !/^https?:\/\//i.test(baseUrl.value)) {
    return { ok: false, error: 'ROUTE_INVALID: baseUrl must start with http:// or https://.' };
  }

  const schemeRaw = body['authScheme'];
  if (typeof schemeRaw !== 'string' || !ROUTE_AUTH_SCHEMES.includes(schemeRaw as RouteAuthScheme)) {
    return { ok: false, error: 'ROUTE_INVALID: authScheme must be bearer, x-api-key, basic, query, body_json, or path.' };
  }
  const authScheme = schemeRaw as RouteAuthScheme;

  const authHeader = optionalText(body['authHeader'], LABEL_MAX, 'authHeader');
  if (!authHeader.ok) return authHeader;
  const bodyField = optionalText(body['bodyField'], FIELD_MAX, 'bodyField');
  if (!bodyField.ok) return bodyField;
  const basicUsername = optionalText(body['basicUsername'], LABEL_MAX, 'basicUsername');
  if (!basicUsername.ok) return basicUsername;

  if ((authScheme === 'x-api-key' || authScheme === 'query') && !authHeader.value) {
    return {
      ok: false,
      error: `ROUTE_INVALID: ${authScheme} needs authHeader — the header or query parameter the vendor reads.`,
    };
  }
  if ((authScheme === 'body_json' || authScheme === 'path') && !bodyField.value) {
    return {
      ok: false,
      error: `ROUTE_INVALID: ${authScheme} needs bodyField — the JSON leaf or path segment that holds the key.`,
    };
  }

  const routeKey = optionalText(body['routeKey'], 64, 'routeKey');
  if (!routeKey.ok) return routeKey;
  if (routeKey.value && !/^[a-z0-9][a-z0-9-]*$/.test(routeKey.value)) {
    return { ok: false, error: 'ROUTE_INVALID: routeKey must be lowercase letters, digits, and dashes.' };
  }

  return {
    ok: true,
    value: {
      routeKey: routeKey.value,
      name: name.value,
      baseUrl: baseUrl.value,
      authScheme,
      authHeader: authHeader.value,
      bodyField: bodyField.value,
      basicUsername: basicUsername.value,
    },
  };
}

/** `Vendor EU edge` -> `vendor-eu-edge`; the caller appends a suffix for uniqueness. */
export function routeKeySlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'route';
}

export const BULK_MAX_LINES = 200;

/**
 * Parses one line for the dashboard's paste-many import. The label keeps
 * everything before the first `=` (so `a=b=c` splits label `a`, secret
 * `b=c`), whitespace is trimmed, and a line with no separator or no content
 * on either side is refused with the 1-based line number in the message.
 * A line may override the batch kind with a `kind:` prefix (`url:X=…`);
 * otherwise the kind is inferred from the label and value.
 */
export function parseBulkVaultLine(
  line: string,
  kind: VaultKind | null = null,
  workspaceId: string | null = null
): { ok: true; value: VaultItemInput } | { ok: false; error: string } {
  let kindSource: 'explicit' | 'inferred' = 'inferred';
  let rest = line;
  const prefix = /^(login|token|url|note):([\s\S]*)$/.exec(rest);
  if (prefix) {
    kindSource = 'explicit';
    rest = prefix[2]!;
  }
  const sep = rest.indexOf('=');
  if (sep === -1) {
    return { ok: false, error: 'BULK_LINE: each line must be LABEL=secret.' };
  }
  const label = rest.slice(0, sep).trim();
  const secret = rest.slice(sep + 1).trim();
  if (!label || !secret) {
    return { ok: false, error: 'BULK_LINE: each line must be LABEL=secret.' };
  }
  const explicitKind = prefix ? (prefix[1] as VaultKind) : null;
  const parsed = parseVaultItem(
    { label, description: label, kind: explicitKind ?? inferVaultKind(label, secret) ?? kind ?? 'token', secret },
    workspaceId
  );
  if (!parsed.ok) return parsed;
  const value = { ...parsed.value, kindSource };
  if (value.kind === 'url' && !value.url && /^https?:\/\//i.test(secret)) {
    value.url = secret;
  }
  return { ok: true, value };
}

