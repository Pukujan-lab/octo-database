/**
 * Client for the self-hosted Umami (UX analytics: clicks, replays, heatmaps), #400.
 *
 * Octo drives Umami as its `admin` user. Each workspace gets a Umami team and one
 * website in it; each workspace member gets a Umami user whose password Octo
 * derives from the admin password and the principal id, so Octo can sign them in
 * (Umami's /sso page) without storing anything. People never see that password.
 *
 *   OCTO_UMAMI_URL             Umami base URL Octo calls (default: the public URL).
 *   OCTO_UMAMI_PUBLIC_URL      where browsers reach Umami (dashboard and tracker).
 *   OCTO_UMAMI_ADMIN_PASSWORD  the Umami admin password.
 *   OCTO_UMAMI_ADMIN_USER      the Umami admin username (default `admin`).
 */

import { createHmac } from 'crypto';

/** Octo workspace role -> Umami team role. Umami's team owner is the admin. */
const TEAM_ROLE: Record<string, string> = {
  owner: 'team-manager',
  admin: 'team-manager',
  operator: 'team-member',
  member: 'team-view-only',
};

/** Replays mask every input and all text (Umami's `strict`), so form fields are never recorded. */
const REPLAY_CONFIG = { replayEnabled: true, heatmapEnabled: true, maskLevel: 'strict', sampleRate: 1 };

export function umamiPublicUrl(): string | null {
  return process.env['OCTO_UMAMI_PUBLIC_URL']?.trim().replace(/\/+$/, '') || null;
}

export function umamiConfigured(): boolean {
  return Boolean(umamiPublicUrl() && process.env['OCTO_UMAMI_ADMIN_PASSWORD']);
}

function baseUrl(): string {
  return (process.env['OCTO_UMAMI_URL']?.trim().replace(/\/+$/, '') || umamiPublicUrl()) ?? '';
}

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`UMAMI_${res.status}: ${method} ${path}`);
  return (await res.json()) as T;
}

async function login(username: string, password: string): Promise<{ token: string; user: { id: string } } | null> {
  try {
    return await call('POST', '/auth/login', null, { username, password });
  } catch {
    return null;
  }
}

async function adminToken(): Promise<string> {
  const user = process.env['OCTO_UMAMI_ADMIN_USER']?.trim() || 'admin';
  const session = await login(user, process.env['OCTO_UMAMI_ADMIN_PASSWORD'] ?? '');
  if (!session) throw new Error('UMAMI_ADMIN_LOGIN_FAILED');
  return session.token;
}

function memberPassword(principalId: string): string {
  return createHmac('sha256', process.env['OCTO_UMAMI_ADMIN_PASSWORD'] ?? '').update(`octo-member:${principalId}`).digest('hex');
}

/** Creates the workspace's team and website, with strict replay masking. */
export async function createUmamiWebsite(input: {
  slug: string;
  name: string;
  domain: string;
}): Promise<{ teamId: string; websiteId: string }> {
  const token = await adminToken();
  // Umami answers with [team, ownerTeamUser]; the admin is the team owner.
  const [team] = await call<[{ id: string }]>('POST', '/teams', token, { name: input.slug.slice(0, 50) });
  const website = await call<{ id: string }>('POST', '/websites', token, {
    name: input.name.slice(0, 100),
    domain: input.domain,
    teamId: team.id,
  });
  await call('POST', `/websites/${website.id}`, token, { replayConfig: REPLAY_CONFIG });
  return { teamId: team.id, websiteId: website.id };
}

/**
 * Makes sure the member has a Umami user in the workspace's team, and returns a
 * sign-in token for them. Usernames are the member's email.
 */
export async function ensureUmamiMember(
  teamId: string,
  member: { principalId: string; email: string; role: string },
  adminTokenIn?: string
): Promise<string> {
  const username = member.email.toLowerCase();
  const password = memberPassword(member.principalId);
  const token = adminTokenIn ?? (await adminToken());
  let session = await login(username, password);
  if (!session) {
    await call('POST', '/users', token, { username, password, role: 'user' });
    session = await login(username, password);
    if (!session) throw new Error('UMAMI_MEMBER_LOGIN_FAILED');
  }
  const role = TEAM_ROLE[member.role] ?? 'team-view-only';
  const teamUsers = await call<{ data: { userId: string; role: string }[] }>(
    'GET',
    `/teams/${teamId}/users?pageSize=1000`,
    token
  );
  const current = teamUsers.data.find((u) => u.userId === session.user.id);
  if (!current) {
    await call('POST', `/teams/${teamId}/users`, token, { userId: session.user.id, role });
  } else if (current.role !== role && current.role !== 'team-owner') {
    await call('POST', `/teams/${teamId}/users/${session.user.id}`, token, { role });
  }
  return session.token;
}

/** Adds every member to the team; returns how many were synced. */
export async function syncUmamiMembers(
  teamId: string,
  members: { principalId: string; email: string; role: string }[]
): Promise<number> {
  const token = await adminToken();
  for (const member of members) await ensureUmamiMember(teamId, member, token);
  return members.length;
}

/** The URL that signs the member in to Umami and opens the workspace's website. */
export function umamiSignInUrl(token: string, websiteId: string): string {
  const params = new URLSearchParams({ token, url: `/websites/${websiteId}` });
  return `${umamiPublicUrl()}/sso?${params.toString()}`;
}

/** The tags a site adds to send page views, clicks, replays and heatmaps. */
export function umamiTrackingTags(websiteId: string): string {
  const base = umamiPublicUrl();
  return [
    `<script defer src="${base}/script.js" data-website-id="${websiteId}"></script>`,
    `<script defer src="${base}/recorder.js" data-website-id="${websiteId}"></script>`,
  ].join('\n');
}

/** Deletes the workspace's website and team. */
export async function deleteUmamiWebsite(teamId: string | null, websiteId: string): Promise<void> {
  const token = await adminToken();
  await call('DELETE', `/websites/${websiteId}`, token);
  if (teamId) await call('DELETE', `/teams/${teamId}`, token);
}
