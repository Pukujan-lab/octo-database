import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, EndpointTable, Exchange, H2, P, PageHeader, Step } from "@/docs/blocks";

const BASE = "https://octodb.design-bakery.com";

export function AnalyticsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="Analytics"
        lead="Analytical questions do not belong in the transactional database. Register immutable Parquet versions and run a named query spec with DuckDB — in-process, no separate service."
      />

      <Callout title="Four rules define this surface">
        The caller never supplies SQL and never supplies an object key. A registration is
        immutable. Query execution is a job. Everything is workspace-fenced — another workspace's
        dataset, job or result answers 404, not 403.
      </Callout>

      <H2 id="endpoints">Endpoints</H2>
      <EndpointTable
        rows={[
          {
            action: "datasets.register",
            method: "POST",
            path: "/api/workspaces/<id>/datasets",
            scope: "write",
            summary: "Register one immutable Parquet dataset version.",
          },
          {
            action: "datasets.list",
            method: "GET",
            path: "/api/workspaces/<id>/datasets",
            scope: "read",
            summary: "List the workspace's datasets with their newest version.",
          },
          {
            action: "analytics.query",
            method: "POST",
            path: "/api/workspaces/<id>/analytics/queries",
            scope: "read",
            summary: "Submit one named query over a dataset version.",
          },
          {
            action: "analytics.query_status",
            method: "GET",
            path: "/api/workspaces/<id>/analytics/queries/<jobId>",
            scope: "read",
            summary: "Read the job's state, and its result once completed.",
          },
          {
            action: "analytics.runs",
            method: "GET",
            path: "/api/workspaces/<id>/analytics/runs",
            scope: "read",
            summary: "List recent analytics jobs with their artifacts.",
          },
          {
            action: "analytics.result",
            method: "GET",
            path: "/api/workspaces/<id>/analytics/results/<resultId>",
            scope: "read",
            summary: "Result metadata plus a short-lived download URL.",
          },
          {
            action: "analytics.result_rows",
            method: "GET",
            path: "/api/workspaces/<id>/analytics/results/<resultId>/rows",
            scope: "read",
            summary: "The artifact as JSON rows, up to 500 at a time.",
          },
        ]}
      />
      <P>
        All of them require at least the <strong>member</strong> role. The named key class{" "}
        <C>analytics</C> is read-only, so it can query but cannot register — registration needs a
        key with <C>write</C>.
      </P>

      <Step n={1} title="Register a dataset version">
        <Exchange
          request={{
            code: `POST /api/workspaces/<id>/datasets
Authorization: Bearer octo_live_ws_...

{
  "dataset": "job-history",
  "name": "Job history export",
  "format": "parquet",
  "schema": [
    { "name": "job_type",   "type": "TEXT" },
    { "name": "state",      "type": "TEXT" },
    { "name": "created_at", "type": "TIMESTAMP" }
  ],
  "provenance": { "source": "octo.jobs", "exportedAt": "2026-10-19T00:00:00Z" },
  "watermark": "2026-10-18T23:59:59Z",
  "parts": [
    { "partition": "2026-09-30", "dataBase64": "<parquet bytes>" }
  ]
}`,
          }}
          response={{
            code: `201 { "datasetVersion": { "id": "...", "version": 1 }, "created": true }`,
            caption: "A repeat with the same idempotencyKey returns the existing registration with `created: false`.",
          }}
        />
        <P>
          The server inspects every Parquet footer, rejects a schema that differs from the
          declaration (<C>SCHEMA_MISMATCH</C>), sums the row counts, assigns the next version under
          a lock, and writes the bytes to keys it derives itself. <C>dataset</C> is a lowercase
          slug that stays stable across versions.
        </P>
        <P>
          A concurrent collision answers <C>409 DATASET_VERSION_CONFLICT</C>. Retry — the retry
          lands on the next version.
        </P>
      </Step>

      <Step n={2} title="Submit a named query">
        <Exchange
          request={{
            code: `POST /api/workspaces/<id>/analytics/queries
Authorization: Bearer octo_live_ws_...

{
  "datasetVersionId": "<uuid>",
  "querySpec": "job-failures-by-type-month@1"
}`,
          }}
          response={{
            code: `201 {
  "job": { "id": "...", "jobType": "analytics_query", "state": "queued" },
  "created": true
}`,
          }}
        />
        <P>
          The default idempotency key is <C>analytics:&lt;datasetVersionId&gt;:&lt;querySpec&gt;</C>,
          so submitting the same query twice returns the same job. Pass your own{" "}
          <C>idempotencyKey</C> to run it again.
        </P>
        <P>
          The one available spec, <C>job-failures-by-type-month@1</C>, takes{" "}
          <C>job_type TEXT</C>, <C>state TEXT</C> and <C>created_at TIMESTAMP</C>, and returns{" "}
          <C>job_type</C>, <C>month</C> (UTC month start) and <C>failure_count</C>.
        </P>
      </Step>

      <Step n={3} title="Poll, then fetch the result">
        <CodeBlock
          label="HTTP"
          code={`GET /api/workspaces/<id>/analytics/queries/<jobId>

→ { jobId, state, jobType, errorCode, errorSummary, resultId, result }`}
        />
        <P>
          <C>state</C> moves <C>queued → running → completed | failed</C>. The worker drains the
          queue on its own interval; <C>POST /api/jobs/run?workspaceId=&lt;id&gt;</C> runs one pass
          immediately if you do not want to wait.
        </P>
        <P>
          On failure, <C>errorCode</C> is one of <C>DATASET_VERSION_NOT_FOUND</C>,{" "}
          <C>PARQUET_MISSING</C>, <C>PARQUET_CORRUPT</C>, <C>SCHEMA_MISMATCH</C>,{" "}
          <C>QUERY_TIMEOUT</C>, <C>QUERY_CANCELLED</C>, <C>RESULT_REGISTRATION_FAILED</C>,{" "}
          <C>ANALYTICS_NOT_CONFIGURED</C> or <C>INVALID_PAYLOAD</C>.
        </P>
        <CodeBlock
          label="HTTP"
          code={`GET /api/workspaces/<id>/analytics/results/<resultId>

→ { result: { id, datasetVersionId, querySpec, objectKey, rowCount,
              contentHash, engineVersion, createdAt },
    downloadUrl, expiresInSeconds }`}
          caption="`downloadUrl` is a presigned URL in production, or the authenticated content route on a local backend."
        />
        <P>
          The artifact is Parquet — read it with DuckDB, pandas, Polars or pyarrow.{" "}
          <C>contentHash</C> is the SHA-256 of the bytes, so a re-run can be compared for
          determinism.
        </P>
      </Step>

      <Step n={4} title="Read the result as rows">
        <Exchange
          request={{
            code: `GET /api/workspaces/<id>/analytics/results/<resultId>/rows?limit=500
Authorization: Bearer octo_live_ws_...`,
          }}
          response={{
            code: `{
  "resultId": "...",
  "querySpec": "job-failures-by-type-month@1",
  "columns": ["job_type", "month", "failure_count"],
  "rows": [
    { "job_type": "archive_file", "month": "2026-01-01 00:00:00", "failure_count": 2 }
  ],
  "rowCount": 1,
  "truncated": false
}`,
            caption: "Dates and decimals come back as strings; integer and decimal columns as numbers. Default and maximum `limit` is 500.",
          }}
        />
        <P>
          This is the dashboard's read path: the artifact is materialised in DuckDB and returned as
          JSON. Month buckets are timestamps at midnight UTC.
        </P>
      </Step>

      <H2 id="catalog">Cheap catalog reads</H2>
      <P>
        The dashboard loads without touching the engine, using two catalog routes:
      </P>
      <CodeBlock
        label="HTTP"
        code={`GET /api/workspaces/<id>/datasets
→ { datasets: [{ datasetId, dataset, name, latestVersionId, latestVersion,
                 versionCount, rowCount, partCount, watermark, createdAt }] }

GET /api/workspaces/<id>/analytics/runs
→ { runs: [{ jobId, state, errorCode, errorSummary, datasetVersionId,
             querySpec, resultId, rowCount, contentHash, engineVersion,
             createdAt, completedAt }] }`}
      />

      <H2 id="availability">Availability</H2>
      <P>
        Analytics is an optional surface, not a boot dependency. If the DuckDB module or the object
        store is unavailable, <C>/health</C> reports{" "}
        <C>analytics: {"{ configured: false }"}</C> and the routes answer{" "}
        <C>503 ANALYTICS_NOT_CONFIGURED</C>. The rest of Octo keeps working.
      </P>
      <CodeBlock
        label="bash"
        code={`curl -s ${BASE}/health | jq .analytics`}
      />

      <P>
        Next:{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/retrieval">
          retrieval and graph
        </Link>{" "}
        over the same workspace.
      </P>
    </>
  );
}
