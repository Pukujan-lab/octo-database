/**
 * Octo MCP adapter.
 *
 * Exposes the workspace surface as MCP tools so an agent can drive Octo with the
 * same token a human or script would use: an account-wide key
 * (`octo_live_acc_`) manages every workspace the principal belongs to, while a
 * workspace-scoped key (`octo_live_ws_`) is confined to its own workspace by the
 * server. The adapter adds no policy of its own — it forwards to the API and
 * reports what the API decided.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OctoApi } from './client';

function asText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function asError(error: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createOctoMcpServer(api: OctoApi): McpServer {
  // Orientation the client receives at connect time, so an agent does not have to
  // learn the platform's rules by trial. Mirrors docs/consuming-octo.md.
  const server = new McpServer(
    { name: 'octo', version: '0.1.0' },
    {
      instructions: [
        'Octo is a self-hosted workspace data platform and the data layer for the projects it serves.',
        "A workspace's durable data lives in Octo: do not stand up a separate database for a project Octo serves. Provision the workspace database through Octo and reach it with query_workspace_database, or with its own connection string.",
        'A workspace-scoped key (octo_live_ws_) reaches only its own workspace and cannot create workspaces or mint keys — both are human-stamped. An account-wide key (octo_live_acc_) manages every workspace the principal belongs to.',
        'The epistemic ledger is append-only and bitemporal: record_epistemic writes; query_claims_as_of and query_belief_as_of read as of a recorded-time and/or valid-time instant.',
        'Historical analytics is register_dataset (immutable Parquet versions) then query_dataset (a named spec, never SQL), polled with get_analytics_query_status and downloaded with get_analytics_result.',
        "Octo's repository is read-only to adopters: propose a change as an OIO observational issue, never a pull request.",
      ].join(' '),
    }
  );

  server.tool('whoami', 'Identify the principal and scopes behind the configured Octo token.', {}, async () => {
    try {
      return asText(await api.me());
    } catch (error) {
      return asError(error);
    }
  });

  server.tool(
    'list_workspaces',
    'List the workspaces the configured token can reach. An account-wide token lists every workspace the principal belongs to; a workspace-scoped token lists only its own.',
    {},
    async () => {
      try {
        return asText(await api.listWorkspaces());
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'create_workspace',
    'Create a workspace, auto-provision its own PostgreSQL database, and mint its first API key. Returns the workspace plus the new key; the raw secret is shown exactly once, and the response reports whether the database was provisioned. Requires an account-wide token — a workspace-scoped key cannot create workspaces.',
    {
      name: z.string().describe('Human-readable workspace name'),
      slug: z.string().optional().describe('URL slug (defaults to a slugified name)'),
      description: z.string().optional().describe('Optional workspace description'),
      retentionDays: z.number().int().positive().optional().describe('Optional retention window in days'),
    },
    async ({ name, slug, description, retentionDays }) => {
      try {
        return asText(await api.createWorkspace({ name, slug, description, retentionDays }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'mint_key',
    'Mint an API key. Omit workspaceId for an account-wide key (one per principal) or pass one for a workspace-scoped key. A token may only narrow its own authority: it cannot widen its scopes or escape its workspace. Minting is human-stamped, so it requires a session with the confirmation secret. The raw secret is shown exactly once.',
    {
      name: z.string().describe('Label for the new key'),
      workspaceId: z.string().optional().describe('Workspace to scope the key to (omit for account-wide)'),
      scopes: z
        .array(z.enum(['read', 'write', 'files', 'delete']))
        .optional()
        .describe('Requested scopes (defaults to read, write, files)'),
      expiresInDays: z.number().int().positive().optional().describe('Optional expiry in days'),
    },
    async ({ name, workspaceId, scopes, expiresInDays }) => {
      try {
        return asText(await api.mintKey({ name, workspaceId, scopes, expiresInDays }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'provision_database',
    'Provision a real PostgreSQL database owned by a workspace and return its connection string. The string is shown exactly once; connect to it with an ordinary Postgres client to create and use your own tables. A workspace created through create_workspace already has a database, so this is for one that does not (it fails with DATABASE_EXISTS otherwise). Requires an account-wide token.',
    { workspaceId: z.string().describe('The workspace to provision a database for') },
    async ({ workspaceId }) => {
      try {
        return asText(await api.provisionDatabase({ workspaceId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'query_workspace_database',
    'Run SQL against a workspace\'s own provisioned database using only the Octo token -- no connection string, host, or port. Read scope runs in a read-only transaction; write scope is required to mutate. A workspace-scoped token may query its own workspace.',
    {
      workspaceId: z.string().describe('The workspace whose database to query'),
      sql: z.string().describe('The SQL to run'),
      params: z.array(z.unknown()).optional().describe('Bind parameters ($1, $2, ...)'),
      rowLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum rows to return (default 1000, max 10000)'),
    },
    async ({ workspaceId, sql, params, rowLimit }) => {
      try {
        return asText(await api.queryWorkspaceDatabase({ workspaceId, sql, params, rowLimit }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'list_files',
    'List the files in a workspace.',
    { workspaceId: z.string().describe('The workspace to list files from') },
    async ({ workspaceId }) => {
      try {
        return asText(await api.listFiles(workspaceId));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'upload_file',
    'Upload a file into a workspace. The content is base64-encoded; the server stores the bytes.',
    {
      workspaceId: z.string().describe('The workspace to upload into'),
      name: z.string().describe('Destination path within the workspace'),
      dataBase64: z.string().describe('File content, base64-encoded'),
      mimeType: z.string().optional().describe('MIME type (defaults to application/octet-stream)'),
    },
    async ({ workspaceId, name, dataBase64, mimeType }) => {
      try {
        return asText(await api.uploadFile({ workspaceId, name, data: dataBase64, mimeType }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'download_file',
    'Download a file\'s bytes from a workspace, returned base64-encoded.',
    {
      workspaceId: z.string().describe('The workspace the file belongs to'),
      fileId: z.string().describe('The file id (from list_files)'),
    },
    async ({ workspaceId, fileId }) => {
      try {
        return asText(await api.downloadFile({ workspaceId, fileId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'delete_file',
    'Delete a file from a workspace. Requires the delete scope and an owner or admin role in the workspace.',
    {
      workspaceId: z.string().describe('The workspace the file belongs to'),
      fileId: z.string().describe('The file id (from list_files)'),
    },
    async ({ workspaceId, fileId }) => {
      try {
        return asText(await api.deleteFile({ workspaceId, fileId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'query_workspace',
    'Answer a natural-language question from a workspace\'s indexed documents.',
    {
      workspaceId: z.string().describe('The workspace to query'),
      query: z.string().describe('The question to answer'),
      limit: z.number().int().positive().optional().describe('Maximum number of passages to retrieve'),
    },
    async ({ workspaceId, query, limit }) => {
      try {
        return asText(await api.query({ workspaceId, query, limit }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'ingest_document',
    'Index a text document into a workspace so query_workspace can retrieve it. Chunks and embeds the text server-side; re-ingesting identical content is a no-op. Uploads via upload_file are NOT indexed automatically — use this tool to make text searchable. Requires the write scope and an operator or higher role.',
    {
      workspaceId: z.string().describe('The workspace to ingest into'),
      title: z.string().describe('Document title (unique per workspace)'),
      text: z.string().describe('The document text to index'),
      mimeType: z.string().optional().describe('MIME type (defaults to text/plain)'),
    },
    async ({ workspaceId, title, text, mimeType }) => {
      try {
        return asText(await api.ingestDocument({ workspaceId, title, text, mimeType }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'list_documents',
    'List the documents indexed in a workspace, newest first, each with its version and chunk counts. Read-only; requires the read scope.',
    { workspaceId: z.string().describe('The workspace to list documents from') },
    async ({ workspaceId }) => {
      try {
        return asText(await api.listDocuments(workspaceId));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'get_document',
    'Read one indexed document and its immutable versions, with each version\'s content hash, mime type, extraction status, and chunk count. Read-only; requires the read scope.',
    {
      workspaceId: z.string().describe('The workspace the document belongs to'),
      documentId: z.string().describe('The document id (from list_documents)'),
    },
    async ({ workspaceId, documentId }) => {
      try {
        return asText(await api.getDocument({ workspaceId, documentId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'rename_document',
    'Rename an indexed document\'s title. Metadata-only: versions stay immutable, so to change the text re-ingest it (which adds a new version). The new title must be unique in the workspace. Requires the write scope and an operator or higher role.',
    {
      workspaceId: z.string().describe('The workspace the document belongs to'),
      documentId: z.string().describe('The document id (from list_documents)'),
      title: z.string().describe('The new title (unique per workspace)'),
    },
    async ({ workspaceId, documentId, title }) => {
      try {
        return asText(await api.renameDocument({ workspaceId, documentId, title }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'delete_document',
    'Delete an indexed document and its derived versions, chunks, and embeddings. Destructive and irreversible: to re-index the text, ingest it again. Requires the delete scope and an owner or admin role.',
    {
      workspaceId: z.string().describe('The workspace the document belongs to'),
      documentId: z.string().describe('The document id (from list_documents)'),
    },
    async ({ workspaceId, documentId }) => {
      try {
        return asText(await api.deleteDocument({ workspaceId, documentId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'query_graph',
    'Run a read-only Cypher query against a workspace\'s graph. The graph is a rebuildable projection of the workspace\'s canonical data, and the query reaches only this workspace\'s graph — the graph name is derived server-side, so no argument can name another. Read-only; requires the read scope.',
    {
      workspaceId: z.string().describe('The workspace whose graph to query'),
      query: z.string().describe('A read-only Cypher query'),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe('Scalar parameters bound into the query'),
    },
    async ({ workspaceId, query, params }) => {
      try {
        return asText(await api.graphQuery({ workspaceId, query, params }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'project_graph',
    'Rebuild a workspace\'s graph from its canonical epistemic ledger. Destroy-and-rebuild, so the result always converges to the same graph for the same data; safe to re-run. Requires the write scope and an operator or higher role.',
    {
      workspaceId: z.string().describe('The workspace whose graph to rebuild'),
    },
    async ({ workspaceId }) => {
      try {
        return asText(await api.graphProject({ workspaceId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'graph_health',
    'The workspace graph projection\'s watermark, counts, and last outcome, plus whether the graph is stale against the live canonical ledger. Requires the read scope.',
    {
      workspaceId: z.string().describe('The workspace whose projection health to read'),
    },
    async ({ workspaceId }) => {
      try {
        return asText(await api.graphHealth({ workspaceId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'record_epistemic',
    'Append one record to a workspace\'s bitemporal knowledge ledger. Nothing is overwritten. `kind` selects the record and which fields it needs: entity {name, entityType?}; perspective {name, description?}; evidence {sourceFileId?|locator?|quote?|contentHash?}; claim {statement, subjectEntityId?, supersedesClaimId?, validFrom?, validTo?, recordedAt?, provenance?}; belief {perspectiveId, claimId, stance, confidence?, validFrom?, validTo?, recordedAt?}; claim_relation {fromClaimId, toClaimId, relation}; claim_evidence {claimId, evidenceId, stance}. stance for a belief is believes|disbelieves|uncertain; for claim_evidence it is supports|contradicts|qualifies. Requires the write scope and an operator or higher role.',
    {
      workspaceId: z.string().describe('The workspace to record into'),
      kind: z
        .enum(['entity', 'perspective', 'evidence', 'claim', 'belief', 'claim_relation', 'claim_evidence'])
        .describe('Which record is being written'),
      name: z.string().optional().describe('entity, perspective: the name'),
      entityType: z.string().optional().describe('entity: type label (default "entity")'),
      description: z.string().optional().describe('perspective: optional description'),
      sourceFileId: z.string().optional().describe('evidence: file id the evidence points at'),
      locator: z.string().optional().describe('evidence: where in the source'),
      quote: z.string().optional().describe('evidence: the quoted passage'),
      contentHash: z.string().optional().describe('evidence: content hash of the source'),
      subjectEntityId: z.string().optional().describe('claim: the entity the claim is about'),
      statement: z.string().optional().describe('claim: the assertion'),
      supersedesClaimId: z.string().optional().describe('claim: close this older claim at the new claim\'s recorded instant'),
      provenance: z.record(z.string(), z.unknown()).optional().describe('claim: provenance to the run/source/version'),
      perspectiveId: z.string().optional().describe('belief: whose belief'),
      claimId: z.string().optional().describe('belief, claim_evidence: the claim'),
      evidenceId: z.string().optional().describe('claim_evidence: the evidence'),
      stance: z.string().optional().describe('belief: believes|disbelieves|uncertain; claim_evidence: supports|contradicts|qualifies'),
      confidence: z.number().optional().describe('belief: 0..1'),
      relation: z
        .string()
        .optional()
        .describe('claim_relation: SUPPORTS|CONTRADICTS|SUPERSEDES|QUALIFIES|DERIVED_FROM|DUPLICATES|REFINES'),
      fromClaimId: z.string().optional().describe('claim_relation: the source claim'),
      toClaimId: z.string().optional().describe('claim_relation: the target claim'),
      validFrom: z.string().optional().describe('ISO 8601 valid-time start'),
      validTo: z.string().optional().describe('ISO 8601 valid-time end'),
      recordedAt: z.string().optional().describe('ISO 8601 recorded-time instant (defaults to now)'),
    },
    async (args) => {
      try {
        return asText(await api.recordEpistemic(args));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'query_claims_as_of',
    'With current knowledge, list the claims considered valid at a world instant, each with its provenance. Applies both time axes: what had been recorded by asOfRecorded, and what was true at asOfValid. Read-only.',
    {
      workspaceId: z.string().describe('The workspace to query'),
      asOfRecorded: z.string().describe('ISO 8601 recorded-time instant (what had been recorded by then)'),
      asOfValid: z.string().optional().describe('ISO 8601 world-time instant (what was true then)'),
    },
    async ({ workspaceId, asOfRecorded, asOfValid }) => {
      try {
        return asText(await api.claimsAsOf({ workspaceId, asOfRecorded, asOfValid }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'query_belief_as_of',
    'What one perspective believed about a claim as of a recorded instant, with the evidence linked to that claim. Two perspectives may hold different beliefs about the same claim. Read-only.',
    {
      workspaceId: z.string().describe('The workspace to query'),
      perspectiveId: z.string().describe('Whose belief to read'),
      claimId: z.string().describe('The claim in question'),
      asOfRecorded: z.string().describe('ISO 8601 recorded-time instant'),
      asOfValid: z.string().optional().describe('ISO 8601 world-time instant (defaults to asOfRecorded)'),
    },
    async ({ workspaceId, perspectiveId, claimId, asOfRecorded, asOfValid }) => {
      try {
        return asText(await api.beliefAsOf({ workspaceId, perspectiveId, claimId, asOfRecorded, asOfValid }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'list_ops_events',
    'List structured operational failure events for a workspace, newest first. Optionally filter to one error code. Read-only.',
    {
      workspaceId: z.string().describe('The workspace to read failures from'),
      errorCode: z.string().optional().describe('Only events with this error code'),
    },
    async ({ workspaceId, errorCode }) => {
      try {
        return asText(await api.listOpsEvents({ workspaceId, errorCode }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'get_ops_summary',
    'Classified failures for a workspace: counts by error code, failures by job type and day, and the jobs needing attention (failed, or running with an expired lease). Read-only; the diagnosis surface for a failed run.',
    { workspaceId: z.string().describe('The workspace to summarize') },
    async ({ workspaceId }) => {
      try {
        return asText(await api.getOpsSummary({ workspaceId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'retry_job',
    'Requeue a failed job so the worker runs it again. Requires the write scope and an owner or admin role in the workspace; a read-only key cannot call it. Use get_ops_summary to find the job id.',
    {
      workspaceId: z.string().describe('The workspace the job belongs to'),
      jobId: z.string().describe('The failed job id (from get_ops_summary or list_ops_events)'),
    },
    async ({ workspaceId, jobId }) => {
      try {
        return asText(await api.retryJob({ workspaceId, jobId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'register_dataset',
    'Register an immutable Parquet dataset version for historical analytics. Supply base64-encoded Parquet parts, the declared column schema, and provenance; the server inspects every footer, rejects a mismatch, assigns the next version, and derives the object keys itself. A re-export is a new version, never a mutation. The schema must carry the query spec inputs (job-failures-by-type-month@1: job_type TEXT, state TEXT, created_at TIMESTAMP). Requires the write scope.',
    {
      workspaceId: z.string().describe('The workspace that owns the dataset'),
      dataset: z.string().describe('Lowercase dataset slug ([a-z0-9-]), stable across versions'),
      name: z.string().optional().describe('Human-readable dataset name'),
      schema: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .describe('Declared columns in file order, e.g. [{name:"job_type",type:"TEXT"}]'),
      provenance: z
        .record(z.string(), z.unknown())
        .describe('Where the export came from: at least { source, exportedAt }'),
      watermark: z.string().optional().describe('Newest source instant included in the export'),
      idempotencyKey: z.string().optional().describe('Retry key; a repeat returns the same version'),
      parts: z
        .array(z.object({ partition: z.string(), dataBase64: z.string() }))
        .describe('Parquet parts: partition is a YYYY-MM-DD date, dataBase64 is the file bytes'),
    },
    async ({ workspaceId, dataset, name, schema, provenance, watermark, idempotencyKey, parts }) => {
      try {
        return asText(
          await api.registerDataset({
            workspaceId,
            dataset,
            name,
            schema,
            provenance,
            watermark,
            idempotencyKey,
            parts,
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'query_dataset',
    'Submit one named analytical query over a registered dataset version and return the enqueued job. The caller names a query spec, never SQL; the server builds the statement and runs it in the background. Available spec: job-failures-by-type-month@1 (failed jobs grouped by job_type and UTC month). Poll with get_analytics_query_status. Requires the read scope.',
    {
      workspaceId: z.string().describe('The workspace that owns the dataset'),
      datasetVersionId: z.string().describe('The dataset version id returned by register_dataset'),
      querySpec: z.string().describe('Named query spec, e.g. job-failures-by-type-month@1'),
      idempotencyKey: z
        .string()
        .optional()
        .describe('Retry key; defaults to analytics:<datasetVersionId>:<querySpec>'),
    },
    async ({ workspaceId, datasetVersionId, querySpec, idempotencyKey }) => {
      try {
        return asText(
          await api.submitAnalyticsQuery({ workspaceId, datasetVersionId, querySpec, idempotencyKey })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'get_analytics_query_status',
    'Read one analytics job: its state (queued, running, completed, failed), error code and summary on failure, and -- once completed -- the result id and artifact metadata. Requires the read scope.',
    {
      workspaceId: z.string().describe('The workspace that owns the job'),
      jobId: z.string().describe('The job id returned by query_dataset'),
    },
    async ({ workspaceId, jobId }) => {
      try {
        return asText(await api.getAnalyticsQueryStatus({ workspaceId, jobId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    'get_analytics_result',
    'Fetch a completed analytics result: its metadata plus a short-lived download URL for the derived Parquet artifact (the content route on a local backend). Requires the read scope.',
    {
      workspaceId: z.string().describe('The workspace that owns the result'),
      resultId: z.string().describe('The result id from get_analytics_query_status'),
    },
    async ({ workspaceId, resultId }) => {
      try {
        return asText(await api.getAnalyticsResult({ workspaceId, resultId }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  return server;
}
