/**
 * Unit tests: the Octo MCP adapter, driven over a real MCP connection.
 *
 * These exercise the adapter the way an agent would: connect an MCP client to
 * the server over an in-memory transport, list the tools, and call them. The
 * point is that the adapter forwards to the API and reports the API's decision —
 * including a refusal, which must surface as a tool error rather than a success.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { OctoApi } from '../../src/mcp/client';
import { createOctoMcpServer } from '../../src/mcp/server';

function apiWith(status: number, body: string, calls: string[] = []): OctoApi {
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return new OctoApi({ baseUrl: 'http://octo.test', token: 'octo_live_acc_test', fetchImpl });
}

async function connect(api: OctoApi): Promise<Client> {
  const server = createOctoMcpServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'octo-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join('');
}

describe('Octo MCP adapter', () => {
  it('advertises the workspace tools an agent manages Octo with', async () => {
    const client = await connect(apiWith(200, '{}'));

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_workspace',
      'delete_document',
      'delete_file',
      'download_file',
      'get_analytics_query_status',
      'get_analytics_result',
      'get_document',
      'get_ops_summary',
      'graph_health',
      'ingest_document',
      'list_documents',
      'list_files',
      'list_ops_events',
      'list_workspaces',
      'mint_key',
      'project_graph',
      'provision_database',
      'query_belief_as_of',
      'query_claims_as_of',
      'query_dataset',
      'query_graph',
      'query_workspace',
      'query_workspace_database',
      'record_epistemic',
      'register_dataset',
      'rename_document',
      'retry_job',
      'upload_file',
      'whoami',
    ]);
  });

  it('returns the API payload for a tool call', async () => {
    const client = await connect(apiWith(200, '[{"id":"w1","name":"Backups"}]'));

    const result = await client.callTool({ name: 'list_workspaces', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Backups');
  });

  it('reports an API refusal as a tool error, not a success', async () => {
    const client = await connect(apiWith(403, '{"error":"FORBIDDEN: key is bound to another workspace"}'));

    const result = await client.callTool({
      name: 'list_files',
      arguments: { workspaceId: '00000000-0000-0000-0000-000000000000' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('403');
  });

  it('scopes a file listing to the requested workspace', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '[]', calls));

    await client.callTool({ name: 'list_files', arguments: { workspaceId: 'ws-42' } });

    expect(calls).toEqual(['http://octo.test/api/files?workspaceId=ws-42']);
  });

  it('creates a workspace and returns the one-time secret', async () => {
    const calls: string[] = [];
    const client = await connect(
      apiWith(201, '{"workspace":{"id":"w1"},"rawSecret":"octo_live_ws_secret"}', calls)
    );

    const result = await client.callTool({ name: 'create_workspace', arguments: { name: 'Project X' } });

    expect(calls).toEqual(['http://octo.test/api/workspaces']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('octo_live_ws_secret');
  });

  it('mints a key against the keys route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(201, '{"apiKey":{"id":"k1"},"rawSecret":"octo_live_ws_k"}', calls));

    const result = await client.callTool({
      name: 'mint_key',
      arguments: { name: 'project', workspaceId: 'w1', scopes: ['read', 'write', 'files'] },
    });

    expect(calls).toEqual(['http://octo.test/api/keys']);
    expect(result.isError).toBeFalsy();
  });

  it('downloads a file through the content route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, 'bytes', calls));

    const result = await client.callTool({
      name: 'download_file',
      arguments: { workspaceId: 'w1', fileId: 'f1' },
    });

    expect(calls).toEqual(['http://octo.test/api/files/content?workspaceId=w1&fileId=f1']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('"Ynl0ZXM="');
  });

  it('deletes a file through the file route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '{"success":true,"fileId":"f1"}', calls));

    const result = await client.callTool({
      name: 'delete_file',
      arguments: { workspaceId: 'w1', fileId: 'f1' },
    });

    expect(calls).toEqual(['http://octo.test/api/files/f1?workspaceId=w1']);
    expect(result.isError).toBeFalsy();
  });

  it('reports a delete refusal as a tool error', async () => {
    const client = await connect(apiWith(403, '{"error":"FORBIDDEN: delete scope required"}'));

    const result = await client.callTool({
      name: 'delete_file',
      arguments: { workspaceId: 'w1', fileId: 'f1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('403');
  });

  it('reports a workspace-creation refusal as a tool error', async () => {
    const client = await connect(
      apiWith(403, '{"error":"FORBIDDEN: A workspace-scoped key cannot create workspaces"}')
    );

    const result = await client.callTool({ name: 'create_workspace', arguments: { name: 'Nope' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('403');
  });

  it('reads the ops summary from the summary route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '{"failureCounts":[],"unhealthyJobs":[]}', calls));

    const result = await client.callTool({
      name: 'get_ops_summary',
      arguments: { workspaceId: 'ws-42' },
    });

    expect(calls).toEqual(['http://octo.test/api/ops/summary?workspaceId=ws-42']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('failureCounts');
  });

  it('filters ops events by error code through the events route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '{"events":[]}', calls));

    await client.callTool({
      name: 'list_ops_events',
      arguments: { workspaceId: 'w1', errorCode: 'INVALID_PAYLOAD' },
    });

    expect(calls).toEqual([
      'http://octo.test/api/ops/events?workspaceId=w1&errorCode=INVALID_PAYLOAD',
    ]);
  });

  it('retries a job through the retry route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '{"success":true,"jobId":"j1"}', calls));

    const result = await client.callTool({
      name: 'retry_job',
      arguments: { workspaceId: 'w1', jobId: 'j1' },
    });

    expect(calls).toEqual(['http://octo.test/api/jobs/j1/retry?workspaceId=w1']);
    expect(result.isError).toBeFalsy();
  });

  it('registers a dataset through the datasets route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(201, '{"datasetVersion":{"id":"v1"},"created":true}', calls));

    const result = await client.callTool({
      name: 'register_dataset',
      arguments: {
        workspaceId: 'w1',
        dataset: 'job-history',
        schema: [
          { name: 'job_type', type: 'TEXT' },
          { name: 'state', type: 'TEXT' },
          { name: 'created_at', type: 'TIMESTAMP' },
        ],
        provenance: { source: 'octo.jobs', exportedAt: '2026-10-19T00:00:00Z' },
        parts: [{ partition: '2026-01-31', dataBase64: 'UEFS' }],
      },
    });

    expect(calls).toEqual(['http://octo.test/api/workspaces/w1/datasets']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('datasetVersion');
  });

  it('submits a named query and polls its job', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(201, '{"job":{"id":"j1"},"created":true}', calls));

    await client.callTool({
      name: 'query_dataset',
      arguments: { workspaceId: 'w1', datasetVersionId: 'v1', querySpec: 'job-failures-by-type-month@1' },
    });
    await client.callTool({
      name: 'get_analytics_query_status',
      arguments: { workspaceId: 'w1', jobId: 'j1' },
    });

    expect(calls).toEqual([
      'http://octo.test/api/workspaces/w1/analytics/queries',
      'http://octo.test/api/workspaces/w1/analytics/queries/j1',
    ]);
  });

  it('fetches a result artifact through the results route', async () => {
    const calls: string[] = [];
    const client = await connect(
      apiWith(200, '{"result":{"id":"r1"},"downloadUrl":"/content","expiresInSeconds":0}', calls)
    );

    const result = await client.callTool({
      name: 'get_analytics_result',
      arguments: { workspaceId: 'w1', resultId: 'r1' },
    });

    expect(calls).toEqual(['http://octo.test/api/workspaces/w1/analytics/results/r1']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('downloadUrl');
  });

  it('reports an unconfigured analytics engine as a tool error, not a success', async () => {
    const client = await connect(apiWith(503, '{"error":"ANALYTICS_NOT_CONFIGURED"}'));

    const result = await client.callTool({
      name: 'query_dataset',
      arguments: { workspaceId: 'w1', datasetVersionId: 'v1', querySpec: 'job-failures-by-type-month@1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('503');
  });

  it('reports a read-only key refused a retry as a tool error, not a success', async () => {
    // retry_job is the one place an agent gains a repair action; a read-only key
    // must be refused by the server (write scope + admin role), and that refusal
    // must surface as an error rather than a silent success.
    const client = await connect(
      apiWith(403, '{"error":"FORBIDDEN: write scope required"}')
    );

    const result = await client.callTool({
      name: 'retry_job',
      arguments: { workspaceId: 'w1', jobId: 'j1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('403');
  });

  it('runs a graph query through the mediated graph route', async () => {
    const calls: string[] = [];
    const client = await connect(
      apiWith(200, '{"query":"MATCH (n) RETURN n","rows":[],"metadata":[]}', calls)
    );

    const result = await client.callTool({
      name: 'query_graph',
      arguments: { workspaceId: 'w1', query: 'MATCH (n) RETURN n' },
    });

    expect(calls).toEqual(['http://octo.test/api/graph/query']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('rows');
  });

  it('reports an unavailable graph engine as a tool error, not a success', async () => {
    // An unconfigured engine answers 503; the adapter must surface that as an
    // error rather than an empty success that reads as "the workspace has no graph".
    const client = await connect(apiWith(503, '{"error":"GRAPH_NOT_CONFIGURED"}'));

    const result = await client.callTool({
      name: 'query_graph',
      arguments: { workspaceId: 'w1', query: 'MATCH (n) RETURN n' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('503');
  });

  it('runs SQL against a workspace database through the query route', async () => {
    const calls: string[] = [];
    const client = await connect(
      apiWith(200, '{"columns":["n"],"rows":[{"n":1}],"rowCount":1,"statementCount":1,"truncated":false}', calls)
    );

    const result = await client.callTool({
      name: 'query_workspace_database',
      arguments: { workspaceId: 'w1', sql: 'SELECT 1 AS n' },
    });

    expect(calls).toEqual(['http://octo.test/api/workspaces/w1/query']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('rowCount');
  });

  it('reports a SQL error as a tool error, not a success', async () => {
    // A statement the database rejects must surface as an error rather than an
    // empty success that reads as "the query ran and returned nothing".
    const client = await connect(
      apiWith(400, '{"error":"SQL_ERROR","message":"syntax error at or near \\"SELEC\\"","code":"42601"}')
    );

    const result = await client.callTool({
      name: 'query_workspace_database',
      arguments: { workspaceId: 'w1', sql: 'SELEC 1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('400');
  });

  it('lists a workspace\'s documents through the documents route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '[{"documentId":"d1","title":"Runbook"}]', calls));

    const result = await client.callTool({ name: 'list_documents', arguments: { workspaceId: 'w1' } });

    expect(calls).toEqual(['http://octo.test/api/rag/documents?workspaceId=w1']);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Runbook');
  });

  it('renames a document through the rename route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '{"documentId":"d1","title":"New"}', calls));

    const result = await client.callTool({
      name: 'rename_document',
      arguments: { workspaceId: 'w1', documentId: 'd1', title: 'New' },
    });

    expect(calls).toEqual(['http://octo.test/api/rag/documents/d1/rename']);
    expect(result.isError).toBeFalsy();
  });

  it('deletes a document through the documents route', async () => {
    const calls: string[] = [];
    const client = await connect(apiWith(200, '{"documentId":"d1","deleted":true}', calls));

    const result = await client.callTool({
      name: 'delete_document',
      arguments: { workspaceId: 'w1', documentId: 'd1' },
    });

    expect(calls).toEqual(['http://octo.test/api/rag/documents/d1?workspaceId=w1']);
    expect(result.isError).toBeFalsy();
  });

  it('reports a document-delete refusal as a tool error, not a success', async () => {
    // Delete needs the delete scope plus an owner/admin role; a key refused it must
    // see an error rather than a silent success that reads as "the document is gone".
    const client = await connect(apiWith(403, '{"error":"FORBIDDEN: Owner or admin role required to delete documents"}'));

    const result = await client.callTool({
      name: 'delete_document',
      arguments: { workspaceId: 'w1', documentId: 'd1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('403');
  });
});
