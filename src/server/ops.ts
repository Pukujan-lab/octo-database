/**
 * Operational capture: agent-action attribution and the structured error events
 * behind the /api/ops surface.
 */

import { AuthContext } from './auth-context';
import { dbRecordActivity, dbRecordOpsEvent, requestIdentity } from './db';
import { UUID_PATTERN } from './runtime';
import { IncomingMessage } from 'http';

/** Attributes an agent action to its principal for audit. Best-effort. */
export async function attributeAgentAction(
  auth: AuthContext,
  workspaceId: string,
  eventType: string,
  summary: string
): Promise<void> {
  if (!auth.apiKey) return;
  try {
    await dbRecordActivity(workspaceId, eventType, summary, null, auth.principal.id);
  } catch {
    // Audit attribution must never break the request path.
  }
}

/**
 * Records a structured operational failure (issue #140, slice O1). Best-effort:
 * a capture failure is swallowed so it can never turn a handled error into a
 * crash. Workspace attribution prefers the request's bound workspace scope, then
 * a UUID `workspaceId` query param, else null (a platform-level event).
 */
export async function captureOpsEvent(
  req: IncomingMessage,
  url: URL,
  event: { eventType: string; errorCode: string; detail: Record<string, unknown> }
): Promise<void> {
  try {
    const scoped = requestIdentity.getStore()?.workspaceId ?? null;
    const fromQuery = url.searchParams.get('workspaceId');
    const workspaceId = scoped ?? (fromQuery && UUID_PATTERN.test(fromQuery) ? fromQuery : null);
    await dbRecordOpsEvent({
      workspaceId,
      source: 'api',
      eventType: event.eventType,
      errorCode: event.errorCode,
      severity: 'error',
      detail: event.detail,
      route: `${req.method} ${url.pathname}`,
    });
  } catch {
    // Operational capture must never break the request path.
  }
}
