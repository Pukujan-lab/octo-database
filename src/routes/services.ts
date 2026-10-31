/**
 * Links to the hosted services Octo fronts (traces and evals, UX analytics, deploy).
 *
 * Octo builds no dashboards for these; the workspace UI shows a button that opens
 * the tool's own UI. The URLs come from the server's configuration, and a service
 * whose URL is unset is reported as not set up. One route family, dispatched by
 * src/server/index.ts. Returns true when this family handled the request.
 */

import { authenticateRequest } from '../server/auth-context';
import { sendJson } from '../server/http';
import { IncomingMessage, ServerResponse } from 'http';

interface ServiceLink {
  id: 'traces' | 'ux' | 'deploy';
  label: string;
  tool: string;
  /** Where the tool's own UI lives, or null when the service is not set up. */
  url: string | null;
}

/** Only http(s) URLs are handed to the browser as a link target. */
function linkFromEnv(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function handleServicesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/api/services' || req.method !== 'GET') return false;

  const auth = await authenticateRequest(req);
  if (!auth) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }

  const services: ServiceLink[] = [
    { id: 'traces', label: 'Traces and evals', tool: 'Phoenix', url: linkFromEnv('OCTO_PHOENIX_PUBLIC_URL') },
    { id: 'ux', label: 'UX analytics', tool: 'Umami', url: linkFromEnv('OCTO_UMAMI_PUBLIC_URL') },
    {
      id: 'deploy',
      label: 'Deploy',
      tool: process.env['OCTO_DEPLOY_TOOL']?.trim() || 'Deploy tool',
      url: linkFromEnv('OCTO_DEPLOY_URL'),
    },
  ];
  sendJson(res, 200, { services });
  return true;
}
