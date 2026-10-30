/**
 * Thin HTTP client for the Octo API.
 *
 * The MCP adapter is a client of the same public API every other surface uses;
 * it holds no database or provider credentials and duplicates no server policy.
 * Authority comes entirely from the bearer token: an account-wide key
 * (`octo_live_acc_`) sees every workspace the principal belongs to, while a
 * workspace-scoped key (`octo_live_ws_`) is confined to its own workspace by the
 * server, so the adapter needs no extra checks of its own.
 */

export class OctoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Octo API request failed (${status}): ${body}`);
    this.name = 'OctoApiError';
  }
}

export interface OctoApiOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class OctoApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OctoApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new OctoApiError(response.status, text);
    return text ? JSON.parse(text) : null;
  }

  capabilities(): Promise<unknown> {
    return this.request('GET', '/api/capabilities');
  }

  me(): Promise<unknown> {
    return this.request('GET', '/api/me');
  }

  createWorkspace(input: {
    name: string;
    slug?: string;
    description?: string;
    retentionDays?: number;
  }): Promise<unknown> {
    return this.request('POST', '/api/workspaces', {
      name: input.name,
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
    });
  }

  mintKey(input: {
    name: string;
    workspaceId?: string;
    scopes?: string[];
    expiresInDays?: number;
  }): Promise<unknown> {
    return this.request('POST', '/api/keys', {
      name: input.name,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      ...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays }),
    });
  }

  listWorkspaces(): Promise<unknown> {
    return this.request('GET', '/api/workspaces');
  }

  provisionDatabase(input: { workspaceId: string }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/database`
    );
  }

  queryWorkspaceDatabase(input: {
    workspaceId: string;
    sql: string;
    params?: unknown[];
    rowLimit?: number;
  }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/query`,
      {
        sql: input.sql,
        ...(input.params === undefined ? {} : { params: input.params }),
        ...(input.rowLimit === undefined ? {} : { rowLimit: input.rowLimit }),
      }
    );
  }

  listFiles(workspaceId: string): Promise<unknown> {
    return this.request('GET', `/api/files?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  uploadFile(input: {
    workspaceId: string;
    name: string;
    data: string;
    mimeType?: string;
  }): Promise<unknown> {
    return this.request('POST', '/api/files/upload', {
      workspaceId: input.workspaceId,
      name: input.name,
      mimeType: input.mimeType ?? 'application/octet-stream',
      data: input.data,
      dataEncoding: 'base64',
    });
  }

  // The content route returns raw bytes, not JSON, so it bypasses request()'s
  // JSON parsing and returns the bytes base64-encoded for transport over MCP.
  private async getBytes(path: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new OctoApiError(response.status, await response.text());
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString('base64');
  }

  downloadFile(input: { workspaceId: string; fileId: string }): Promise<string> {
    return this.getBytes(
      `/api/files/content?workspaceId=${encodeURIComponent(input.workspaceId)}&fileId=${encodeURIComponent(input.fileId)}`
    );
  }

  deleteFile(input: { workspaceId: string; fileId: string }): Promise<unknown> {
    return this.request(
      'DELETE',
      `/api/files/${encodeURIComponent(input.fileId)}?workspaceId=${encodeURIComponent(input.workspaceId)}`
    );
  }

  query(input: { workspaceId: string; query: string; limit?: number }): Promise<unknown> {
    return this.request('POST', '/api/rag/query', {
      workspaceId: input.workspaceId,
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  ingestDocument(input: {
    workspaceId: string;
    title: string;
    text: string;
    mimeType?: string;
  }): Promise<unknown> {
    return this.request('POST', '/api/rag/documents', {
      workspaceId: input.workspaceId,
      title: input.title,
      text: input.text,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    });
  }

  listDocuments(workspaceId: string): Promise<unknown> {
    return this.request('GET', `/api/rag/documents?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  getDocument(input: { workspaceId: string; documentId: string }): Promise<unknown> {
    return this.request(
      'GET',
      `/api/rag/documents/${encodeURIComponent(input.documentId)}?workspaceId=${encodeURIComponent(input.workspaceId)}`
    );
  }

  renameDocument(input: { workspaceId: string; documentId: string; title: string }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/rag/documents/${encodeURIComponent(input.documentId)}/rename`,
      { workspaceId: input.workspaceId, title: input.title }
    );
  }

  deleteDocument(input: { workspaceId: string; documentId: string }): Promise<unknown> {
    return this.request(
      'DELETE',
      `/api/rag/documents/${encodeURIComponent(input.documentId)}?workspaceId=${encodeURIComponent(input.workspaceId)}`
    );
  }

  graphQuery(input: {
    workspaceId: string;
    query: string;
    params?: Record<string, string | number | boolean | null>;
  }): Promise<unknown> {
    return this.request('POST', '/api/graph/query', {
      workspaceId: input.workspaceId,
      query: input.query,
      ...(input.params === undefined ? {} : { params: input.params }),
    });
  }

  graphProject(input: { workspaceId: string }): Promise<unknown> {
    return this.request('POST', '/api/graph/project', { workspaceId: input.workspaceId });
  }

  graphHealth(input: { workspaceId: string }): Promise<unknown> {
    const params = new URLSearchParams({ workspaceId: input.workspaceId });
    return this.request('GET', `/api/graph/health?${params.toString()}`);
  }

  recordEpistemic(input: Record<string, unknown> & { workspaceId: string; kind: string }): Promise<unknown> {
    return this.request('POST', '/api/epistemic/record', input);
  }

  claimsAsOf(input: { workspaceId: string; asOfRecorded: string; asOfValid?: string }): Promise<unknown> {
    const params = new URLSearchParams({
      workspaceId: input.workspaceId,
      asOfRecorded: input.asOfRecorded,
    });
    if (input.asOfValid !== undefined) params.set('asOfValid', input.asOfValid);
    return this.request('GET', `/api/epistemic/claims-as-of?${params.toString()}`);
  }

  beliefAsOf(input: {
    workspaceId: string;
    perspectiveId: string;
    claimId: string;
    asOfRecorded: string;
    asOfValid?: string;
  }): Promise<unknown> {
    const params = new URLSearchParams({
      workspaceId: input.workspaceId,
      perspectiveId: input.perspectiveId,
      claimId: input.claimId,
      asOfRecorded: input.asOfRecorded,
    });
    if (input.asOfValid !== undefined) params.set('asOfValid', input.asOfValid);
    return this.request('GET', `/api/epistemic/belief-as-of?${params.toString()}`);
  }

  listOpsEvents(input: { workspaceId: string; errorCode?: string }): Promise<unknown> {
    const params = new URLSearchParams({ workspaceId: input.workspaceId });
    if (input.errorCode !== undefined) params.set('errorCode', input.errorCode);
    return this.request('GET', `/api/ops/events?${params.toString()}`);
  }

  getOpsSummary(input: { workspaceId: string }): Promise<unknown> {
    return this.request('GET', `/api/ops/summary?workspaceId=${encodeURIComponent(input.workspaceId)}`);
  }

  registerDataset(input: {
    workspaceId: string;
    dataset: string;
    name?: string;
    schema: Array<{ name: string; type: string }>;
    provenance: Record<string, unknown>;
    watermark?: string;
    idempotencyKey?: string;
    parts: Array<{ partition: string; dataBase64: string }>;
  }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/datasets`,
      {
        dataset: input.dataset,
        format: 'parquet',
        ...(input.name === undefined ? {} : { name: input.name }),
        schema: input.schema,
        provenance: input.provenance,
        ...(input.watermark === undefined ? {} : { watermark: input.watermark }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        parts: input.parts,
      }
    );
  }

  submitAnalyticsQuery(input: {
    workspaceId: string;
    datasetVersionId: string;
    querySpec: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/analytics/queries`,
      {
        datasetVersionId: input.datasetVersionId,
        querySpec: input.querySpec,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }
    );
  }

  getAnalyticsQueryStatus(input: { workspaceId: string; jobId: string }): Promise<unknown> {
    return this.request(
      'GET',
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/analytics/queries/${encodeURIComponent(input.jobId)}`
    );
  }

  getAnalyticsResult(input: { workspaceId: string; resultId: string }): Promise<unknown> {
    return this.request(
      'GET',
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/analytics/results/${encodeURIComponent(input.resultId)}`
    );
  }

  retryJob(input: { workspaceId: string; jobId: string }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/jobs/${encodeURIComponent(input.jobId)}/retry?workspaceId=${encodeURIComponent(input.workspaceId)}`
    );
  }
}
