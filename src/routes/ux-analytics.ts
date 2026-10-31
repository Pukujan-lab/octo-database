/**
 * UX analytics per workspace (#400): clicks, session replays and heatmaps in the
 * self-hosted Umami.
 *
 *   GET  /api/workspaces/:id/ux-analytics       is it on, the website id, the tracking tags
 *   POST /api/workspaces/:id/ux-analytics       turn it on ({ domain }); owner or admin.
 *                                               Creates the Umami team and website once,
 *                                               then adds every member to the team.
 *   GET  /api/workspaces/:id/ux-analytics/link  a URL that signs the caller in to Umami
 *                                               on the workspace's website
 *
 * One route family, dispatched by src/server/index.ts.
 */

import {
  createUmamiWebsite,
  ensureUmamiMember,
  syncUmamiMembers,
  umamiConfigured,
  umamiSignInUrl,
  umamiTrackingTags,
} from '../lib/umami';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import {
  dbGetWorkspaceById,
  dbGetWorkspaceMembership,
  dbGetWorkspaceUmami,
  dbListWorkspaceMemberEmails,
  dbSetWorkspaceUmami,
} from '../server/db';
import { readJsonObject, sendJson } from '../server/http';
import { UUID_PATTERN } from '../server/runtime';
import type { IncomingMessage, ServerResponse } from 'http';

const ROUTE = /^\/api\/workspaces\/([^/]+)\/ux-analytics(\/link)?$/;
const DOMAIN = /^[a-z0-9.-]+(:\d+)?$/i;

export async function handleUxAnalyticsRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const [, workspaceId, link] = match as unknown as [string, string, string | undefined];
  const turnOn = req.method === 'POST' && !link;
  if (req.method !== 'GET' && !turnOn) return false;

  const auth = await authenticateRequest(req);
  if (!auth) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }
  const scope = turnOn ? 'write' : 'read';
  if (!requireScope(auth, scope)) {
    scopeDenied(res, scope);
    return true;
  }
  if (!UUID_PATTERN.test(workspaceId)) {
    sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
    return true;
  }
  if (!keyWorkspaceMatches(auth, workspaceId)) {
    sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
    return true;
  }
  const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
  if (!mem) {
    sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
    return true;
  }
  const workspace = await dbGetWorkspaceById(workspaceId);
  const umami = await dbGetWorkspaceUmami(workspaceId);
  if (!workspace || !umami) {
    sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND' });
    return true;
  }
  if (!umamiConfigured()) {
    sendJson(res, 503, { error: 'UX_ANALYTICS_NOT_CONFIGURED: set OCTO_UMAMI_PUBLIC_URL and OCTO_UMAMI_ADMIN_PASSWORD' });
    return true;
  }

  try {
    if (link) {
      if (!umami.websiteId || !umami.teamId) {
        sendJson(res, 404, { error: 'UX_ANALYTICS_OFF: turn it on for this workspace first' });
        return true;
      }
      const token = await ensureUmamiMember(umami.teamId, {
        principalId: auth.principal.id,
        email: auth.principal.email,
        role: mem.role,
      });
      sendJson(res, 200, { url: umamiSignInUrl(token, umami.websiteId) });
      return true;
    }

    if (turnOn) {
      if (!roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required' });
        return true;
      }
      let { teamId, websiteId } = umami;
      if (!websiteId || !teamId) {
        const domain = String((await readJsonObject(req)).domain ?? '').trim().toLowerCase();
        if (!DOMAIN.test(domain)) {
          sendJson(res, 400, { error: 'BAD_REQUEST: domain is the app\'s host name, e.g. app.example.com' });
          return true;
        }
        ({ teamId, websiteId } = await createUmamiWebsite({ slug: workspace.slug, name: workspace.name, domain }));
        if (!(await dbSetWorkspaceUmami(workspaceId, teamId, websiteId))) {
          sendJson(res, 409, { error: 'UX_ANALYTICS_RACE: turned on by another request; retry' });
          return true;
        }
      }
      const members = await syncUmamiMembers(teamId, await dbListWorkspaceMemberEmails(workspaceId));
      sendJson(res, 200, { enabled: true, websiteId, members, tags: umamiTrackingTags(websiteId) });
      return true;
    }

    sendJson(res, 200, {
      enabled: Boolean(umami.websiteId),
      websiteId: umami.websiteId,
      tags: umami.websiteId ? umamiTrackingTags(umami.websiteId) : null,
    });
    return true;
  } catch (err) {
    console.error('[ux-analytics]', err instanceof Error ? err.message : String(err));
    sendJson(res, 502, { error: 'UX_ANALYTICS_UPSTREAM_FAILED' });
    return true;
  }
}
