import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, EndpointTable, Exchange, H2, H3, P, PageHeader, UL } from "@/docs/blocks";

export function RetrievalPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="Retrieval, graph and ledger"
        lead="Three surfaces that share a workspace: a hybrid retrieval index, a Cypher-queryable graph projection, and the bitemporal claim ledger the graph is rebuilt from."
      />

      <H2 id="retrieval">Retrieval</H2>
      <P>
        Ingest a text document and Octo chunks it, embeds it, and stores the result so a query can
        retrieve it. Search is <strong>hybrid</strong>: a lexical arm and a vector arm, fused with
        reciprocal rank fusion, so an exact term and a paraphrase both work.
      </P>
      <EndpointTable
        rows={[
          {
            action: "rag.ingest",
            method: "POST",
            path: "/api/rag/documents",
            scope: "write",
            role: "operator",
            summary: "Index a document: chunk, embed, store.",
          },
          {
            action: "rag.query",
            method: "POST",
            path: "/api/rag/query",
            scope: "read",
            summary: "Hybrid search across the workspace's indexed documents.",
          },
          {
            action: "rag.list",
            method: "GET",
            path: "/api/rag/documents?workspaceId=<id>",
            scope: "read",
            summary: "List indexed documents with version and chunk counts.",
          },
          {
            action: "rag.get",
            method: "GET",
            path: "/api/rag/documents/<id>?workspaceId=<id>",
            scope: "read",
            summary: "One document and its immutable versions.",
          },
          {
            action: "rag.rename",
            method: "POST",
            path: "/api/rag/documents/<id>/rename?workspaceId=<id>",
            scope: "write",
            role: "operator",
            summary: "Retitle a document. Metadata only — versions stay immutable.",
          },
          {
            action: "rag.delete",
            method: "DELETE",
            path: "/api/rag/documents/<id>?workspaceId=<id>",
            scope: "delete",
            role: "admin",
            summary: "Delete a document with its versions, chunks and embeddings.",
          },
        ]}
      />
      <Exchange
        request={{
          code: `POST /api/rag/documents
Authorization: Bearer octo_live_ws_...

{
  "workspaceId": "6f1c2a90-...",
  "title": "Incident 162 postmortem",
  "text": "...",
  "mimeType": "text/plain"
}`,
        }}
        response={{
          code: `POST /api/rag/query
{ "workspaceId": "6f1c2a90-...", "query": "why did the migration fail?", "limit": 5 }

→ {
  "query": "...",
  "mode": "hybrid",
  "matches": [
    { "chunkId": "...", "documentId": "...", "content": "...",
      "similarity": 0.81, "lexicalScore": 0.44, "version": 2 }
  ]
}`,
          caption: "`similarity` is null for a chunk only the lexical arm found; `lexicalScore` is null for a vector-only match.",
        }}
      />
      <Callout tone="warning" title="Embeddings must be configured">
        Ingest and query both need an embedding provider. Without one they answer{" "}
        <C>503 EMBEDDING_PROVIDER_NOT_CONFIGURED</C> and name the two environment variables the
        operator must set. Authorisation runs first, so an unauthorised caller never learns whether
        the provider exists.
      </Callout>

      <H2 id="ledger">The claim ledger</H2>
      <P>
        The ledger is <strong>bitemporal</strong>: every record carries a valid time (when the
        claim was true in the world) and a recorded time (when Octo learned it). Nothing is
        overwritten — a correction is a new row, and superseding a claim closes the older claim's
        recorded-time interval rather than rewriting it.
      </P>
      <EndpointTable
        rows={[
          {
            action: "epistemic.record",
            method: "POST",
            path: "/api/epistemic/record",
            scope: "write",
            role: "operator",
            summary: "Append one record: entity, perspective, evidence, claim, belief, claim_relation or claim_evidence.",
          },
          {
            action: "epistemic.claims_as_of",
            method: "GET",
            path: "/api/epistemic/claims-as-of?workspaceId=<id>&asOfRecorded=<iso>&asOfValid=<iso>",
            scope: "read",
            summary: "Claims considered valid at a world instant, each with provenance.",
          },
          {
            action: "epistemic.belief_as_of",
            method: "GET",
            path: "/api/epistemic/belief-as-of?workspaceId=<id>&perspectiveId=<id>&claimId=<id>&asOfRecorded=<iso>&asOfValid=<iso>",
            scope: "read",
            summary: "What one perspective believed about a claim as of a recorded instant.",
          },
        ]}
      />
      <Exchange
        request={{
          code: `POST /api/epistemic/record
Authorization: Bearer octo_live_ws_...

{
  "workspaceId": "6f1c2a90-...",
  "kind": "claim",
  "claim": "The 2026-10 migration dropped the legacy index.",
  "validFrom": "2026-10-09T00:00:00Z",
  "recordedAt": "2026-10-28T09:14:02Z",
  "supersedesClaimId": null
}`,
        }}
        response={{
          code: `GET /api/epistemic/claims-as-of?workspaceId=<id>
    &asOfRecorded=2026-10-28T12:00:00Z
    &asOfValid=2026-10-09T12:00:00Z

→ {
  "claims": [
    { "claimId": "...", "claim": "...", "validFrom": "...",
      "recordedAt": "...", "provenance": [ ... ] }
  ]
}`,
        }}
      />
      <P>
        Two perspectives may hold different beliefs about the same claim; the answer cites the
        evidence linked to that claim rather than picking a winner.
      </P>

      <H2 id="graph">The graph</H2>
      <P>
        The graph is a <strong>read model</strong>. It is rebuilt from the canonical ledger, so a
        rebuild always converges to the same graph for the same rows. Query it with read-only
        Cypher; never write to it directly.
      </P>
      <EndpointTable
        rows={[
          {
            action: "graph.project",
            method: "POST",
            path: "/api/graph/project",
            scope: "write",
            role: "operator",
            summary: "Destroy and rebuild the workspace graph from the ledger.",
          },
          {
            action: "graph.health",
            method: "GET",
            path: "/api/graph/health?workspaceId=<id>",
            scope: "read",
            summary: "Watermark, counts, last outcome, and whether the projection is stale.",
          },
          {
            action: "graph.query",
            method: "POST",
            path: "/api/graph/query",
            scope: "read",
            summary: "Read-only Cypher against the workspace graph.",
          },
        ]}
      />
      <Exchange
        request={{
          code: `POST /api/graph/query
Authorization: Bearer octo_live_ws_...

{
  "workspaceId": "6f1c2a90-...",
  "query": "MATCH (c:Claim)-[:SUPERSEDES]->(o) RETURN c.id, o.id LIMIT 10"
}`,
        }}
        response={{
          code: `{
  "columns": ["c.id", "o.id"],
  "rows": [["claim-1", "claim-0"]],
  "rowCount": 1
}`,
          caption: "The graph name is derived from the workspace, never passed by the caller — a query cannot name another workspace's graph.",
        }}
      />
      <H3 id="staleness">Detecting staleness</H3>
      <P>
        <C>graph.health</C> compares the projection's watermark against the live ledger. If the
        ledger has moved on, the graph is stale and a projection is due — the response says so
        rather than leaving you to guess.
      </P>

      <H2 id="choosing">Choosing between them</H2>
      <UL>
        <li>
          <strong>Retrieval</strong> when the question is "which passage answers this?" — fuzzy,
          language-shaped, over unstructured text.
        </li>
        <li>
          <strong>The ledger</strong> when the question is "what did we know, and when?" — exact,
          temporal, with provenance.
        </li>
        <li>
          <strong>The graph</strong> when the question is "how are these things connected?" —
          traversal over relationships the ledger recorded.
        </li>
      </UL>

      <P>
        Next:{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/vault">
          the vault
        </Link>{" "}
        — spending a vendor credential without holding it.
      </P>
    </>
  );
}
