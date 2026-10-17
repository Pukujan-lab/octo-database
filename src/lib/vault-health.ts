/**
 * Health of a stored vault item.
 *
 * Live checks are the vendor calls that already exist: Cloudflare's token
 * verify endpoint, an HTTP status for a URL, and zxcvbn for a password.
 * A network failure does not mark an item stale. 401 and 403 do.
 */

import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common';
import { buildUpstreamRequest, type RelayRoute } from './relay-egress';
import { UNCHECKED_STALE_MS, type VaultKind } from './vault-policy';

const passwordChecker = new ZxcvbnFactory({ graphs: adjacencyGraphs, dictionary });

export type VaultHealthStatus = 'unchecked' | 'healthy' | 'weak' | 'stale';

export interface HealthVerdict {
  status: VaultHealthStatus;
  detail: string;
}

export type HealthProbe = (url: string, headers: Record<string, string>, method: 'GET' | 'HEAD') => Promise<number | 'error'>;

function scorePassword(secret: string): number {
  return passwordChecker.check(secret).score;
}

function cloudflareHost(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'api.cloudflare.com' || host === 'dash.cloudflare.com';
  } catch {
    return false;
  }
}

/**
 * Classifies one item. `createdAtMs` lets an item that can never be probed
 * become stale instead of sitting unchecked forever. The purge clock starts
 * when the status first becomes `stale`; this function does not delete.
 */
export async function checkVaultItem(
  item: { kind: VaultKind; url: string | null; createdAtMs: number },
  secret: string | null,
  probe: HealthProbe,
  now = Date.now()
): Promise<HealthVerdict> {
  if (item.kind === 'login' || item.kind === 'note') {
    if (!secret) return ageOut({ status: 'unchecked', detail: 'nothing to score' }, item.createdAtMs, now);
    const score = scorePassword(secret);
    if (score <= 1) return { status: 'weak', detail: `password score ${score}/4` };
    return { status: 'healthy', detail: `password score ${score}/4` };
  }

  if (item.kind === 'url') {
    const target = secret && /^https?:\/\//i.test(secret) ? secret : item.url;
    if (!target) return ageOut({ status: 'unchecked', detail: 'no url' }, item.createdAtMs, now);
    const status = await probe(target, {}, 'HEAD');
    return fromHttp(status, item.createdAtMs, now);
  }

  if (secret && cloudflareHost(item.url)) {
    const status = await probe(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { Authorization: `Bearer ${secret}` },
      'GET'
    );
    return fromHttp(status, item.createdAtMs, now);
  }

  if (secret && item.url && /^https?:\/\//i.test(item.url)) {
    const status = await probe(item.url, { Authorization: `Bearer ${secret}` }, 'GET');
    return fromHttp(status, item.createdAtMs, now);
  }

  return ageOut({ status: 'unchecked', detail: 'no live check for this item' }, item.createdAtMs, now);
}

function fromHttp(status: number | 'error', createdAtMs: number, now: number): HealthVerdict {
  if (status === 'error') return ageOut({ status: 'unchecked', detail: 'check did not connect' }, createdAtMs, now);
  if (status === 401 || status === 403) return { status: 'stale', detail: `rejected with ${status}` };
  if (status >= 200 && status < 300) return { status: 'healthy', detail: `responded ${status}` };
  if (status === 404 || status === 410) return { status: 'stale', detail: `gone with ${status}` };
  return ageOut({ status: 'unchecked', detail: `responded ${status}` }, createdAtMs, now);
}

function ageOut(verdict: HealthVerdict, createdAtMs: number, now: number): HealthVerdict {
  if (verdict.status !== 'unchecked') return verdict;
  if (now - createdAtMs >= UNCHECKED_STALE_MS) {
    return { status: 'stale', detail: 'unchecked for 30 days' };
  }
  return verdict;
}

/**
 * A base-URL probe can only prove the host answered: most vendor roots have no
 * handler and 404. 401/403 still mean the key is bad, and a 5xx or a network
 * failure means the vendor is not usable.
 */
export function classifyRouteProbe(status: number | 'error'): { status: string; detail: string } {
  if (status === 'error') return { status: 'unreachable', detail: 'host did not answer' };
  if (status === 401) return { status: 'unauthorized', detail: 'upstream rejected the key (401)' };
  if (status === 403) return { status: 'forbidden_group', detail: 'key valid but not entitled (403)' };
  if (status >= 500) return { status: 'unreachable', detail: `upstream ${status}` };
  return { status: 'ok', detail: `host answered ${status}` };
}

const PROBE_TEMP_KEY = 'octo_tmp_probe';

/**
 * Builds the request a route health check sends: the same upstream request the
 * relay would build, with no caller path or body. Returns null when the scheme
 * cannot be probed without one (a JSON body field).
 */
export function buildRouteProbe(
  route: RelayRoute & { routeKey: string },
  secret: string
): { url: string; headers: Record<string, string> } | null {
  const built = buildUpstreamRequest({
    route,
    secret,
    tempKey: PROBE_TEMP_KEY,
    method: 'GET',
    url: new URL(`http://relay.local/api/vault/relay/${route.routeKey}`),
    headers: {},
    body: null,
  });
  if ('error' in built) return null;
  return { url: built.url, headers: built.headers };
}
