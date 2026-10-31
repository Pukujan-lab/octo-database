/**
 * The capability catalogue the client builds its UI from.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { AUTH_GUIDANCE, capabilitiesForScopes, minimumRoleForCapability } from '../api/capabilities';
import { authenticateRequest, effectiveWorkspaceRole, keyWorkspaceMatches, roleMeetsMinimum } from '../server/auth-context';
import { dbGetWorkspaceById, dbGetWorkspaceMembership } from '../server/db';
import { umamiConfigured } from '../lib/umami';
import { sendJson } from '../server/http';
import { archiveDeps, graphClient, objectStore, publicTarget, UUID_PATTERN } from '../server/runtime';
import { WorkspaceRole } from '../types/auth';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleCapabilitiesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 9b. Workspace-aware capability discovery.
  if (pathname === '/api/capabilities' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, {
        error: 'UNAUTHENTICATED',
        code: 'UNAUTHENTICATED',
        message: 'A valid Octo credential is required.',
      });
      return true;
    }

    const requestedWorkspaceId = url.searchParams.get('workspaceId');
    if (requestedWorkspaceId !== null && !UUID_PATTERN.test(requestedWorkspaceId)) {
      sendJson(res, 400, {
        error: 'INVALID_WORKSPACE_ID',
        code: 'INVALID_WORKSPACE_ID',
        message: 'workspaceId must be a UUID.',
      });
      return true;
    }

    const scopes = auth.apiKey ? auth.apiKey.scopes : ['read', 'write', 'delete', 'files'];
    let workspace: { id: string; role: WorkspaceRole } | null = null;
    let unavailable: { action: string; reason: 'PROVIDER_UNAVAILABLE' }[] = [];
    let capabilities = capabilitiesForScopes(scopes);

    if (requestedWorkspaceId) {
      if (!keyWorkspaceMatches(auth, requestedWorkspaceId)) {
        sendJson(res, 403, {
          error: 'WORKSPACE_ACCESS_DENIED',
          code: 'WORKSPACE_ACCESS_DENIED',
          message: 'This credential cannot access the requested workspace.',
        });
        return true;
      }

      let mem;
      try {
        const exists = await dbGetWorkspaceById(requestedWorkspaceId);
        mem = exists ? await dbGetWorkspaceMembership(requestedWorkspaceId, auth.principal.id) : null;
      } catch {
        sendJson(res, 500, {
          error: 'CAPABILITY_LOOKUP_FAILED',
          code: 'CAPABILITY_LOOKUP_FAILED',
          message: 'Workspace capabilities could not be loaded.',
        });
        return true;
      }
      if (!mem) {
        sendJson(res, 403, {
          error: 'WORKSPACE_ACCESS_DENIED',
          code: 'WORKSPACE_ACCESS_DENIED',
          message: 'This credential cannot access the requested workspace.',
        });
        return true;
      }

      const role = effectiveWorkspaceRole(auth, mem.role);
      workspace = { id: requestedWorkspaceId, role };
      capabilities = capabilities.filter((capability) => {
        if (capability.action === 'workspaces.create') return !auth.apiKey?.workspaceId;
        return roleMeetsMinimum(role, minimumRoleForCapability(capability.action));
      });

      const providerByAction: Record<string, boolean> = {
        'files.download': Boolean(objectStore),
        'files.upload': Boolean(objectStore),
        'files.publish': Boolean(objectStore && publicTarget),
        'files.unpublish': Boolean(objectStore && publicTarget),
        'files.delete': Boolean(objectStore),
        'files.archive': Boolean(objectStore && archiveDeps),
        'files.restore': Boolean(objectStore && archiveDeps),
        'graph.query': Boolean(graphClient),
        'traces.ingest': Boolean(process.env['OCTO_PHOENIX_URL']),
        'traces.link': Boolean(process.env['OCTO_PHOENIX_URL']),
        'ux_analytics.enable': umamiConfigured(),
        'ux_analytics.link': umamiConfigured(),
      };
      const supported = [] as typeof capabilities;
      for (const capability of capabilities) {
        const configured = providerByAction[capability.action];
        if (configured === false) unavailable.push({ action: capability.action, reason: 'PROVIDER_UNAVAILABLE' });
        else supported.push(capability);
      }
      capabilities = supported;
    } else if (auth.apiKey?.workspaceId) {
      capabilities = capabilities.filter((capability) => capability.action !== 'workspaces.create');
    }

    sendJson(res, 200, {
      contractVersion: 1,
      discoveryMode: requestedWorkspaceId ? 'workspace' : 'unbound',
      workspace,
      principal: {
        id: auth.principal.id,
        isGuest: auth.principal.isGuest,
        // No email, provider token, or infrastructure credential is disclosed.
      },
      token: auth.apiKey
        ? {
            prefix: auth.apiKey.prefix,
            workspaceId: auth.apiKey.workspaceId,
            isAccountWide: auth.apiKey.isAccountWide,
            scopes: auth.apiKey.scopes,
          }
        : { type: 'session' },
      auth: AUTH_GUIDANCE,
      capabilities,
      unavailable,
    });
    return true;
  }

  return false;
}
