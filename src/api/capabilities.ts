/**
 * Agent Capability Discovery and Scope Enforcement (Slice 7)
 *
 * Capability discovery describes HOW to call Octo. The token's scopes define WHAT
 * the principal may do, and they are enforced server-side on every call -- the
 * description is documentation, never the enforcement mechanism.
 */

export type OctoScope = 'read' | 'write' | 'delete' | 'files';

export interface CapabilityDescriptor {
  action: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** Scope required to invoke this action. */
  requiredScope: OctoScope;
  description: string;
}

/**
 * The platform surface agents may call. Ordering is stable so capability output is
 * deterministic and diffable.
 */
export const OCTO_CAPABILITIES: CapabilityDescriptor[] = [
  {
    action: 'workspaces.list',
    method: 'GET',
    path: '/api/workspaces',
    requiredScope: 'read',
    description: 'List workspaces this principal is authorized to use.',
  },
  {
    action: 'workspaces.create',
    method: 'POST',
    path: '/api/workspaces',
    requiredScope: 'write',
    description:
      'Create a workspace and auto-provision its own PostgreSQL database and its first key. Not available to workspace-scoped keys.',
  },
  {
    action: 'workspaces.provision_database',
    method: 'POST',
    path: '/api/workspaces/<id>/database',
    requiredScope: 'write',
    description:
      'Provision a real PostgreSQL database owned by a workspace and return its connection string exactly once. A workspace created through POST /api/workspaces already has one; this route is for a workspace that does not, and fails with DATABASE_EXISTS otherwise. Not available to workspace-scoped keys.',
  },
  {
    action: 'workspaces.query',
    method: 'POST',
    path: '/api/workspaces/<id>/query',
    requiredScope: 'read',
    description:
      'Run SQL against a workspace\'s own provisioned database with just an Octo API key -- no connection string, host, or port. The server authenticates as the workspace\'s own role; read scope runs in a read-only transaction, and write scope is required to mutate. Available to workspace-scoped keys for their own workspace.',
  },
  {
    action: 'files.list',
    method: 'GET',
    path: '/api/files?workspaceId=<id>',
    requiredScope: 'files',
    description: 'List active files in an authorized workspace.',
  },
  {
    action: 'files.download',
    method: 'GET',
    path: '/api/files/download?workspaceId=<id>&fileId=<id>',
    requiredScope: 'files',
    description: 'Get a short-lived download URL for one file.',
  },
  {
    action: 'files.upload',
    method: 'POST',
    path: '/api/files/upload',
    requiredScope: 'write',
    description: 'Upload bytes into an authorized workspace.',
  },
  {
    action: 'files.publish',
    method: 'POST',
    path: '/api/files/<fileId>/publish?workspaceId=<id>',
    requiredScope: 'write',
    description:
      'Copy one active file into the public bucket and return its stable HTTPS URL. Nothing else in the workspace is published.',
  },
  {
    action: 'files.unpublish',
    method: 'POST',
    path: '/api/files/<fileId>/unpublish?workspaceId=<id>',
    requiredScope: 'write',
    description: 'Remove that file\'s public URL. The private file stays in the workspace.',
  },
  {
    action: 'files.delete',
    method: 'DELETE',
    path: '/api/files/<fileId>?workspaceId=<id>',
    requiredScope: 'delete',
    description: 'Delete a file. Destructive; requires the delete scope.',
  },
  {
    action: 'files.archive',
    method: 'POST',
    path: '/api/files/<fileId>/archive?workspaceId=<id>',
    requiredScope: 'delete',
    description: 'Move a file from active storage to the cold archive. Restored on demand.',
  },
  {
    action: 'files.restore',
    method: 'POST',
    path: '/api/files/<fileId>/restore?workspaceId=<id>',
    requiredScope: 'write',
    description: 'Pull an archived file back into active storage.',
  },
  {
    action: 'jobs.list',
    method: 'GET',
    path: '/api/jobs?workspaceId=<id>',
    requiredScope: 'read',
    description: 'List background jobs for an authorized workspace.',
  },
  {
    action: 'jobs.enqueue',
    method: 'POST',
    path: '/api/jobs',
    requiredScope: 'write',
    description: 'Enqueue background work in an authorized workspace.',
  },
  {
    action: 'gallery.list',
    method: 'GET',
    path: '/api/gallery?workspaceId=<id>',
    requiredScope: 'files',
    description: 'List gallery media in an authorized workspace.',
  },
  {
    action: 'jobs.run',
    method: 'POST',
    path: '/api/jobs/run?workspaceId=<id>',
    requiredScope: 'write',
    description: 'Drain one pass of the background job queue for an authorized workspace.',
  },
  {
    action: 'datasets.register',
    method: 'POST',
    path: '/api/workspaces/<id>/datasets',
    requiredScope: 'write',
    description:
      'Register an immutable Parquet dataset version: supply base64 parts, a declared schema, and provenance; the server validates the Parquet footers, assigns the next version, derives the object keys, and writes the bytes. A re-export is a new version, never a mutation. Pass append: true to extend the newest version with new date partitions without re-uploading earlier ones.',
  },
  {
    action: 'analytics.register_spec',
    method: 'POST',
    path: '/api/workspaces/<id>/analytics/specs',
    requiredScope: 'write',
    description:
      'Register a workspace query spec: one SELECT over a dataset (exposed to the SQL as the view "data") with typed $params. The server validates it against the dataset schema and stores it as an immutable version, ws:<slug>@<n>. A spec can read only the dataset version it is run over.',
  },
  {
    action: 'analytics.specs',
    method: 'GET',
    path: '/api/workspaces/<id>/analytics/specs',
    requiredScope: 'read',
    description: 'List the workspace\'s registered query specs with their SQL and parameters.',
  },
  {
    action: 'analytics.schedule',
    method: 'POST',
    path: '/api/workspaces/<id>/analytics/schedules',
    requiredScope: 'write',
    description:
      'Run a spec on a schedule: every N minutes (5 to 10080), over a dataset\'s newest version, writing the result rows into analytics.<table> in the workspace database (replace or upsert by key columns). A run is skipped until a new dataset version has landed.',
  },
  {
    action: 'analytics.schedules',
    method: 'GET',
    path: '/api/workspaces/<id>/analytics/schedules',
    requiredScope: 'read',
    description: 'List the workspace\'s analytics schedules with their next run time and the dataset version each last ran on.',
  },
  {
    action: 'analytics.unschedule',
    method: 'DELETE',
    path: '/api/workspaces/<id>/analytics/schedules/<scheduleId>',
    requiredScope: 'write',
    description: 'Delete an analytics schedule. Rows it already wrote stay in the workspace database.',
  },
  {
    action: 'analytics.query',
    method: 'POST',
    path: '/api/workspaces/<id>/analytics/queries',
    requiredScope: 'read',
    description:
      'Submit one named analytical query over a registered dataset version. The caller names a built-in spec or a registered workspace spec (ws:<slug>@<n>) plus its params, never raw SQL; the server enqueues an analytics_query job. Poll the job with analytics.query_status.',
  },
  {
    action: 'analytics.query_status',
    method: 'GET',
    path: '/api/workspaces/<id>/analytics/queries/<jobId>',
    requiredScope: 'read',
    description:
      'Read one analytics job\'s state, error code and summary, and -- once completed -- its result id and artifact metadata.',
  },
  {
    action: 'analytics.result',
    method: 'GET',
    path: '/api/workspaces/<id>/analytics/results/<resultId>',
    requiredScope: 'read',
    description:
      'Fetch a completed analytics result: its metadata plus a short-lived download URL for the derived Parquet artifact.',
  },
  {
    action: 'activity.list',
    method: 'GET',
    path: '/api/activity?workspaceId=<id>',
    requiredScope: 'read',
    description: 'Read the activity feed for an authorized workspace.',
  },
  {
    action: 'ops.list',
    method: 'GET',
    path: '/api/ops/events?workspaceId=<id>&errorCode=<code>',
    requiredScope: 'read',
    description: 'List structured operational failure events for an authorized workspace.',
  },
  {
    action: 'ops.summary',
    method: 'GET',
    path: '/api/ops/summary?workspaceId=<id>',
    requiredScope: 'read',
    description:
      'Classified failures for an authorized workspace: counts by error code, by job type and day, and the jobs needing attention.',
  },
  {
    action: 'epistemic.record',
    method: 'POST',
    path: '/api/epistemic/record',
    requiredScope: 'write',
    description:
      'Append one record to an authorized workspace\'s bitemporal knowledge ledger. `kind` selects the record: entity, perspective, evidence, claim, belief, claim_relation, or claim_evidence. Nothing is overwritten -- a correction is a new row; recording a claim with supersedesClaimId closes the older claim\'s recorded-time interval instead of rewriting it. Requires operator role or higher.',
  },
  {
    action: 'epistemic.claims_as_of',
    method: 'GET',
    path: '/api/epistemic/claims-as-of?workspaceId=<id>&asOfRecorded=<iso>&asOfValid=<iso>',
    requiredScope: 'read',
    description:
      'With current knowledge, list the claims considered valid at a world instant, each with its provenance. Applies both time axes: recorded time (what had been recorded by asOfRecorded) and valid time (what was true at asOfValid).',
  },
  {
    action: 'epistemic.belief_as_of',
    method: 'GET',
    path: '/api/epistemic/belief-as-of?workspaceId=<id>&perspectiveId=<id>&claimId=<id>&asOfRecorded=<iso>&asOfValid=<iso>',
    requiredScope: 'read',
    description:
      'What one perspective believed about a claim as of a recorded instant, with the evidence linked to that claim. Two perspectives may hold different beliefs about the same claim; the answer cites the sources.',
  },
  {
    action: 'graph.project',
    method: 'POST',
    path: '/api/graph/project',
    requiredScope: 'write',
    description:
      'Rebuild an authorized workspace\'s graph from the canonical epistemic ledger. Destroy-and-rebuild: the graph is a read model, so a rebuild always converges to the same graph for the same rows. Requires operator role or higher.',
  },
  {
    action: 'graph.health',
    method: 'GET',
    path: '/api/graph/health?workspaceId=<id>',
    requiredScope: 'read',
    description:
      'The workspace graph projection\'s watermark, counts, and last outcome, plus whether the graph is stale against the live canonical ledger.',
  },
  {
    action: 'graph.query',
    method: 'POST',
    path: '/api/graph/query',
    requiredScope: 'read',
    description:
      'Run a read-only Cypher query against an authorized workspace\'s graph. The graph name is derived from the workspace, never passed by the caller, so a query can never name another workspace\'s graph.',
  },
  {
    action: 'rag.ingest',
    method: 'POST',
    path: '/api/rag/documents',
    requiredScope: 'write',
    description:
      'Index a text document into an authorized workspace: chunk, embed, and store it so semantic query can retrieve it. Requires operator role or higher.',
  },
  {
    action: 'rag.list',
    method: 'GET',
    path: '/api/rag/documents?workspaceId=<id>',
    requiredScope: 'read',
    description: 'List the documents indexed in an authorized workspace, with version and chunk counts.',
  },
  {
    action: 'rag.get',
    method: 'GET',
    path: '/api/rag/documents/<id>?workspaceId=<id>',
    requiredScope: 'read',
    description: 'Read one indexed document and its immutable versions.',
  },
  {
    action: 'rag.rename',
    method: 'POST',
    path: '/api/rag/documents/<id>/rename?workspaceId=<id>',
    requiredScope: 'write',
    description:
      'Rename an indexed document\'s title. Metadata-only: versions stay immutable, so changing the text is a re-ingest, not a rename. Requires operator role or higher.',
  },
  {
    action: 'rag.delete',
    method: 'DELETE',
    path: '/api/rag/documents/<id>?workspaceId=<id>',
    requiredScope: 'delete',
    description:
      'Delete an indexed document and its derived versions, chunks, and embeddings. Destructive; requires owner or admin role.',
  },
  {
    action: 'keys.revoke',
    method: 'DELETE',
    path: '/api/keys/<keyId>',
    requiredScope: 'delete',
    description: 'Revoke one of this principal\'s API keys. Destructive.',
  },
];

/**
 * Named key classes: the authority profiles a consumer is provisioned under.
 *
 * A class is a mint-time preset over the real scopes, never a second
 * authorization dimension -- a key stores only its resolved `scopes`, and every
 * route is decided by `requireScope`. The catalog exists so a consumer can be
 * handed a profile by name ("analytics") whose reach is documented, instead of a
 * hand-picked scope list whose reach is left implicit.
 *
 * Every class is still bounded by workspace membership, role, the workspace
 * binding of a scoped key, provider availability, and the human confirmation /
 * MFA gates. No class grants a SQL surface directly; a write-scoped account-wide
 * key can provision a workspace database (as it can create a workspace), and the
 * credential that call returns is the database's own, not a control-plane one.
 */
export interface KeyClassProfile {
  label: string;
  description: string;
  scopes: OctoScope[];
}

export const KEY_CLASSES = {
  analytics: {
    label: 'Analytics',
    description:
      'Read-only workspace, job, activity, and share metadata, plus RAG retrieval. No file or gallery bytes and no mutations.',
    scopes: ['read'],
  },
  'agent-read': {
    label: 'Agent (read-only)',
    description:
      'Analytics access plus file, gallery, and media reads. No writes and no destructive actions.',
    scopes: ['read', 'files'],
  },
  'program-write': {
    label: 'Program (write)',
    description:
      'Agent-read access plus upload, publish, unpublish, restore, job enqueue/run, document ingestion, and share creation. No delete, archive, or revocation.',
    scopes: ['read', 'write', 'files'],
  },
} as const satisfies Record<string, KeyClassProfile>;

export type KeyClass = keyof typeof KEY_CLASSES;

/**
 * Named permission presets for the key picker, mapped onto the four real scopes.
 * `custom` means an explicit scope list instead.
 */
export const SCOPE_PRESETS: { id: string; label: string; scopes: OctoScope[] }[] = [
  { id: 'read-only', label: 'Read-only', scopes: ['read', 'files'] },
  { id: 'read-write', label: 'Read-write', scopes: ['read', 'write', 'files'] },
  { id: 'ingest', label: 'Ingest', scopes: ['write', 'files'] },
  { id: 'full', label: 'Full', scopes: ['read', 'write', 'files', 'delete'] },
];

/**
 * Capabilities a token may actually invoke, given its scopes.
 * A capability is included only when its required scope is present.
 */
export function capabilitiesForScopes(scopes: string[]): CapabilityDescriptor[] {
  const granted = new Set(scopes);
  return OCTO_CAPABILITIES.filter((capability) => granted.has(capability.requiredScope));
}

/** Workspace role required for the operations exposed by the current inventory. */
export function minimumRoleForCapability(action: string): 'member' | 'operator' | 'admin' {
  if (action === 'files.delete' || action === 'rag.delete') return 'admin';
  if (
    ['files.upload', 'files.publish', 'files.unpublish', 'files.archive', 'files.restore', 'jobs.enqueue', 'jobs.run', 'epistemic.record', 'graph.project', 'rag.ingest', 'rag.rename'].includes(
      action
    )
  ) {
    return 'operator';
  }
  return 'member';
}

/** True when the granted scopes permit the required scope. */
export function hasScope(scopes: string[], required: OctoScope): boolean {
  return scopes.includes(required);
}

/**
 * Human/agent-facing description of how to authenticate. Contains no secrets and
 * no infrastructure credentials -- only the shape of the call.
 *
 * The note records the one deliberate exception to "tokens never expose a database
 * credential": a provisioned workspace database returns its own connection string
 * once to the caller that provisioned it. That credential is scoped to that one
 * database and carries no access to Octo control-plane data.
 */
export const AUTH_GUIDANCE = {
  scheme: 'Bearer',
  header: 'Authorization: Bearer <octo_live_...>',
  note:
    'Agent tokens grant only their listed scopes within their bound workspace (or all ' +
    'authorized workspaces for account-wide keys). They never expose provider or ' +
    'infrastructure credentials. The one deliberate exception is a provisioned workspace ' +
    'database: its own connection string is returned once to the caller that provisioned ' +
    'it, and it carries no access to Octo control-plane data.',
} as const;
