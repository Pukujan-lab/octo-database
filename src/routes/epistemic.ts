/**
 * The bitemporal epistemic ledger: record and as-of reads.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { contentHash } from '../rag/pipeline';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbBeliefAsOf, dbClaimsAsOf, dbEnsureEpistemicEntity, dbEnsurePerspective, dbGetWorkspaceMembership, dbInsertBelief, dbInsertClaim, dbInsertClaimEvidence, dbInsertClaimRelation, dbInsertEvidence } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { UUID_PATTERN } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleEpistemicRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // Epistemic ledger: POST /api/epistemic/record -- one append-only write into a
  // workspace's bitemporal knowledge ledger. The `kind` selects which record is
  // being written; each kind validates only its own fields.
  if (pathname === '/api/epistemic/record' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const body = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, kind } = body;

    if (!workspaceId || !kind) {
      sendJson(res, 400, { error: 'workspaceId and kind are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to record epistemic data' });
      return true;
    }

    const createdBy = auth.principal.id;
    const asTimestamp = (value: unknown, field: string): { ok: true; value: string | null } | { ok: false } => {
      if (value === undefined || value === null) return { ok: true, value: null };
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        sendJson(res, 400, { error: `${field} must be an ISO 8601 timestamp` });
        return { ok: false };
      }
      return { ok: true, value };
    };
    const asUuidOrNull = (value: unknown, field: string): { ok: true; value: string | null } | { ok: false } => {
      if (value === undefined || value === null || value === '') return { ok: true, value: null };
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        sendJson(res, 400, { error: `${field} must be a UUID` });
        return { ok: false };
      }
      return { ok: true, value };
    };

    try {
      if (kind === 'entity') {
        const { name, entityType } = body;
        if (typeof name !== 'string' || !name.trim()) {
          sendJson(res, 400, { error: 'name is required to record an entity' });
          return true;
        }
        const entity = await dbEnsureEpistemicEntity(
          workspaceId,
          name,
          typeof entityType === 'string' && entityType.trim() ? entityType : 'entity'
        );
        sendJson(res, 201, { kind, entity });
        return true;
      }

      if (kind === 'perspective') {
        const { name, description } = body;
        if (typeof name !== 'string' || !name.trim()) {
          sendJson(res, 400, { error: 'name is required to record a perspective' });
          return true;
        }
        const perspective = await dbEnsurePerspective(
          workspaceId,
          name,
          typeof description === 'string' ? description : null
        );
        sendJson(res, 201, { kind, perspective });
        return true;
      }

      if (kind === 'evidence') {
        const sourceFileId = asUuidOrNull(body.sourceFileId, 'sourceFileId');
        if (!sourceFileId.ok) return true;
        const { locator, quote, contentHash } = body;
        if (
          sourceFileId.value === null &&
          !(typeof locator === 'string' && locator.trim()) &&
          !(typeof quote === 'string' && quote.trim()) &&
          !(typeof contentHash === 'string' && contentHash.trim())
        ) {
          sendJson(res, 400, {
            error: 'evidence requires at least one of sourceFileId, locator, quote, or contentHash',
          });
          return true;
        }
        const evidence = await dbInsertEvidence({
          workspaceId,
          sourceFileId: sourceFileId.value,
          locator: typeof locator === 'string' ? locator : null,
          quote: typeof quote === 'string' ? quote : null,
          contentHash: typeof contentHash === 'string' ? contentHash : null,
          createdBy,
        });
        sendJson(res, 201, { kind, evidence });
        return true;
      }

      if (kind === 'claim') {
        const subjectEntityId = asUuidOrNull(body.subjectEntityId, 'subjectEntityId');
        if (!subjectEntityId.ok) return true;
        const supersedesClaimId = asUuidOrNull(body.supersedesClaimId, 'supersedesClaimId');
        if (!supersedesClaimId.ok) return true;
        const validFrom = asTimestamp(body.validFrom, 'validFrom');
        if (!validFrom.ok) return true;
        const validTo = asTimestamp(body.validTo, 'validTo');
        if (!validTo.ok) return true;
        const recordedAt = asTimestamp(body.recordedAt, 'recordedAt');
        if (!recordedAt.ok) return true;
        const { statement, provenance } = body;
        if (typeof statement !== 'string' || !statement.trim()) {
          sendJson(res, 400, { error: 'statement is required to record a claim' });
          return true;
        }
        if (provenance !== undefined && (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance))) {
          sendJson(res, 400, { error: 'provenance must be a JSON object' });
          return true;
        }
        const claim = await dbInsertClaim({
          workspaceId,
          subjectEntityId: subjectEntityId.value,
          statement,
          validFrom: validFrom.value,
          validTo: validTo.value,
          recordedAt: recordedAt.value,
          provenance: (provenance as Record<string, unknown>) ?? {},
          supersedesClaimId: supersedesClaimId.value,
          createdBy,
        });
        sendJson(res, 201, { kind, claim });
        return true;
      }

      if (kind === 'belief') {
        const perspectiveId = asUuidOrNull(body.perspectiveId, 'perspectiveId');
        if (!perspectiveId.ok) return true;
        const claimId = asUuidOrNull(body.claimId, 'claimId');
        if (!claimId.ok) return true;
        const validFrom = asTimestamp(body.validFrom, 'validFrom');
        if (!validFrom.ok) return true;
        const validTo = asTimestamp(body.validTo, 'validTo');
        if (!validTo.ok) return true;
        const recordedAt = asTimestamp(body.recordedAt, 'recordedAt');
        if (!recordedAt.ok) return true;
        const { stance, confidence } = body;
        if (!perspectiveId.value || !claimId.value) {
          sendJson(res, 400, { error: 'perspectiveId and claimId are required to record a belief' });
          return true;
        }
        if (!['believes', 'disbelieves', 'uncertain'].includes(stance)) {
          sendJson(res, 400, { error: 'stance must be one of believes, disbelieves, uncertain' });
          return true;
        }
        if (confidence !== undefined && confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
          sendJson(res, 400, { error: 'confidence must be a number between 0 and 1' });
          return true;
        }
        const belief = await dbInsertBelief({
          workspaceId,
          perspectiveId: perspectiveId.value,
          claimId: claimId.value,
          stance,
          confidence: typeof confidence === 'number' ? confidence : null,
          validFrom: validFrom.value,
          validTo: validTo.value,
          recordedAt: recordedAt.value,
        });
        sendJson(res, 201, { kind, belief });
        return true;
      }

      if (kind === 'claim_relation') {
        const fromClaimId = asUuidOrNull(body.fromClaimId, 'fromClaimId');
        if (!fromClaimId.ok) return true;
        const toClaimId = asUuidOrNull(body.toClaimId, 'toClaimId');
        if (!toClaimId.ok) return true;
        const recordedAt = asTimestamp(body.recordedAt, 'recordedAt');
        if (!recordedAt.ok) return true;
        const { relation } = body;
        if (!fromClaimId.value || !toClaimId.value) {
          sendJson(res, 400, { error: 'fromClaimId and toClaimId are required' });
          return true;
        }
        const relations = ['SUPPORTS', 'CONTRADICTS', 'SUPERSEDES', 'QUALIFIES', 'DERIVED_FROM', 'DUPLICATES', 'REFINES'];
        if (!relations.includes(relation)) {
          sendJson(res, 400, { error: `relation must be one of ${relations.join(', ')}` });
          return true;
        }
        if (fromClaimId.value === toClaimId.value) {
          sendJson(res, 400, { error: 'a claim cannot relate to itself' });
          return true;
        }
        const created = await dbInsertClaimRelation({
          workspaceId,
          fromClaimId: fromClaimId.value,
          toClaimId: toClaimId.value,
          relation,
          recordedAt: recordedAt.value,
          createdBy,
        });
        sendJson(res, 201, { kind, claimRelation: created });
        return true;
      }

      if (kind === 'claim_evidence') {
        const claimId = asUuidOrNull(body.claimId, 'claimId');
        if (!claimId.ok) return true;
        const evidenceId = asUuidOrNull(body.evidenceId, 'evidenceId');
        if (!evidenceId.ok) return true;
        const { stance } = body;
        if (!claimId.value || !evidenceId.value) {
          sendJson(res, 400, { error: 'claimId and evidenceId are required' });
          return true;
        }
        if (!['supports', 'contradicts', 'qualifies'].includes(stance)) {
          sendJson(res, 400, { error: 'stance must be one of supports, contradicts, qualifies' });
          return true;
        }
        const link = await dbInsertClaimEvidence({
          workspaceId,
          claimId: claimId.value,
          evidenceId: evidenceId.value,
          stance,
        });
        sendJson(res, 201, { kind, claimEvidence: link });
        return true;
      }

      sendJson(res, 400, {
        error: 'kind must be one of entity, perspective, evidence, claim, belief, claim_relation, claim_evidence',
      });
      return true;
    } catch (error) {
      // A foreign key to another workspace's row, or a value the schema rejects,
      // surfaces as a clean 400 rather than a raw 500 with database text.
      const message = error instanceof Error ? error.message : 'record failed';
      sendJson(res, 400, { error: 'EPISTEMIC_RECORD_REJECTED', message });
      return true;
    }
  }

  // Epistemic ledger: GET /api/epistemic/claims-as-of -- query mode 2. With
  // current knowledge, which claims do we now consider valid at a world instant?
  if (pathname === '/api/epistemic/claims-as-of' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId') ?? '';
    const asOfRecorded = url.searchParams.get('asOfRecorded') ?? '';
    const asOfValid = url.searchParams.get('asOfValid');

    if (!workspaceId || !asOfRecorded) {
      sendJson(res, 400, { error: 'workspaceId and asOfRecorded are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (Number.isNaN(Date.parse(asOfRecorded))) {
      sendJson(res, 400, { error: 'asOfRecorded must be an ISO 8601 timestamp' });
      return true;
    }
    if (asOfValid !== null && Number.isNaN(Date.parse(asOfValid))) {
      sendJson(res, 400, { error: 'asOfValid must be an ISO 8601 timestamp' });
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

    const claims = await dbClaimsAsOf(workspaceId, asOfRecorded, asOfValid ?? null);
    sendJson(res, 200, { asOfRecorded, asOfValid: asOfValid ?? null, claims });
    return true;
  }

  // Epistemic ledger: GET /api/epistemic/belief-as-of -- query mode 1. What did
  // perspective P believe about a claim as of a recorded instant?
  if (pathname === '/api/epistemic/belief-as-of' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId') ?? '';
    const perspectiveId = url.searchParams.get('perspectiveId') ?? '';
    const claimId = url.searchParams.get('claimId') ?? '';
    const asOfRecorded = url.searchParams.get('asOfRecorded') ?? '';
    const asOfValidParam = url.searchParams.get('asOfValid');

    if (!workspaceId || !perspectiveId || !claimId || !asOfRecorded) {
      sendJson(res, 400, {
        error: 'workspaceId, perspectiveId, claimId, and asOfRecorded are required',
      });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!requireUuid(res, perspectiveId, 'perspectiveId')) return true;
    if (!requireUuid(res, claimId, 'claimId')) return true;
    if (Number.isNaN(Date.parse(asOfRecorded))) {
      sendJson(res, 400, { error: 'asOfRecorded must be an ISO 8601 timestamp' });
      return true;
    }
    // Valid time defaults to the recorded instant: "what did we believe at T
    // about T". A caller may separate the two axes explicitly.
    const asOfValid = asOfValidParam ?? asOfRecorded;
    if (Number.isNaN(Date.parse(asOfValid))) {
      sendJson(res, 400, { error: 'asOfValid must be an ISO 8601 timestamp' });
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

    const result = await dbBeliefAsOf(workspaceId, perspectiveId, claimId, asOfRecorded, asOfValid);
    sendJson(res, 200, { perspectiveId, claimId, asOfRecorded, asOfValid, ...result });
    return true;
  }

  return false;
}
