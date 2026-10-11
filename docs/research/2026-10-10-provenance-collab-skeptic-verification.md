# Skeptic verification — provenance-collab report

Date: 2026-10-10. Verifier role: skeptic, second pass over the provenance-collab researcher's
claims. Method: every existence claim checked against the live GitHub API (`gh api repos/<repo>`),
every feature claim against the named primary source (repo README/design doc, vendor docs page,
standards page, paper landing page), fetched directly. Web-search budget was exhausted
(200/200, same as the first pass), so verification leans on GitHub API + direct WebFetch of
primary URLs. Datomic's license line was left unresolved (see below).

## Verdicts

### 1. Lemmalog/Synalog — partially_true (verdict holds; one sub-claim refuted in the researcher's favor)

Verified against `JordyZomer/lemmalog` (API: MIT, 329 stars, 30 forks, 47 commits, **0 releases,
0 tags**, 4 contributors, last push 2026-10-01) and the repo's README + `datalog-context-engine-design.md`:

- Bi-temporal facts via `valid_from`/`valid_to`/`asserted_at` — confirmed (design doc §3.1).
- Supersession as retraction-by-annotation (`valid_to` set), never deletion — confirmed (design doc §3.1).
- Semiring annotations: confidence (product t-norm) × provenance (set union) — confirmed (README table + design doc §3.1, citing Green et al. PODS 2007).
- Seminaive + DRed-lite scoped recompute; leapfrog triejoins and DBSP deltas marked "future phases" — confirmed exactly as the researcher said.
- `why()` proof trees, MCP server, 12 tools — confirmed (README).
- Experimental, no adopters/papers — confirmed.

**Correction:** the researcher wrote "no evidence of a separate 'Synalog'". Synalog **exists**:
`SynaLinks/synalog`, Apache-2.0, 12 stars, 0 forks, beta, last push 2026-10-08 — "Logic programming
for AI agents: Datalog-family language compiling to optimized SQL", a Rust rewrite of Logica
compiling to SQLite/DuckDB/BigQuery/PostgreSQL/Presto/Trino/Databricks. It is a dynamic semantic
layer + virtual knowledge graph over SQL engines, **not** a bi-temporal/provenance-semiring
deductive database, so Lemmalog's assessment and the maturity picture are unchanged. Lemmalog's
own design doc (line 13) cites "Synalog (SynaLinks)" as adjacent prior art. Sub-claim refuted;
verdict unchanged.

### 2. TerminusDB — partially_true (verdict holds; one quoted phrase unverified)

- `terminusdb/terminusdb`: Apache-2.0, 3,435 stars, 157 forks, latest release v12.0.7 (2026-08-10), ~47 contributors.
- **Official docs literally state "TerminusDB is a datalog engine — its query evaluator natively
  resolves logical predicates, performs unification"** (terminusdb.org/docs/what-is-datalog).
- README: "Document + Knowledge Graph", "Multimodal: REST API, GraphQL, WOQL and with Closed World
  RDF", "Built in unification, path queries, and a datalog logic engine", "WOQL Datalog".
- "New maintainers since 2025" = DFRNT, confirmed on terminusdb.org ("by the new maintainers of
  TerminusDB since 2025"; "© 2026 DFRNT").
- **Unverified:** the exact phrase "core differentiator of the query engine" does not appear on the
  current what-is-datalog page (closest: "The Key Mechanism"). Possibly from an older docs revision
  or another page; treat the quote as unconfirmed.
- **Unsupported:** the comparative "handles open/closed-world transitions better than SQL" has no
  source anywhere. Closed-world RDF is documented; a superiority claim over SQL is not.
- "Native Datalog engine" overstates identity: TerminusDB is a document/RDF graph database where
  Datalog (WOQL) is one query interface alongside GraphQL and the document API.

### 3. RDFox / Souffle — supported

- **RDFox** (oxfordsemantic.tech, proprietary commercial; Samsung-acquired OST): homepage names
  Dow Jones, Inserm, Yale, Siemens, Samsung; "The only knowledge graph that operates in-memory";
  "Incremental Reasoning" (updates materialize without reload). Datalog support sits in the docs
  ("Rule Languages", "The Rule Language of RDFox", "Materialization-Based Reasoning") rather than
  the homepage; Datalog-based reasoning is RDFox's documented core. No K operator found — the claim
  concedes this and frames "program epistemic rules" as manual encoding, which is accurate.
- **Souffle** (`souffle-lang/souffle`): UPL-1.0, 1,184 stars, 247 forks. README: "Efficient
  translation to parallel C++ of Datalog programs (CAV'16, CC'16)"; official site: "A Datalog
  Synthesis Tool for Static Analysis". Oracle Labs origin: not stated on the current site/README
  (the CAV'16 authors — Jordan, Scholz, Subotic — are historically Oracle Labs; Scholz's Oracle
  affiliation is well established in the literature). "Standard Datalog engine in program-analysis
  research" is a fair characterization of its CAV/PLDI/TOPLAS citation record but is not claimed in
  so many words on the site.

### 4. No native epistemic support in PostgreSQL/MySQL — supported

GitHub search `postgres+epistemic` → 0 relevant repositories; no Postgres/MySQL extension adding
modal/epistemic operators surfaced from any angle. Bitemporal capability in the reported family is
real only in separate engines: XTDB (`xtdb/xtdb`, MPL-2.0, 3,080 stars) — README: "all data is
accurately versioned... 'system' time, but it also allows you to separately record and query when
that data is, was, or will become valid in your business domain ('valid' time)... SQL:2011...
available over the Postgres wire protocol" — and Datahike (`replikativ/datahike`, EPL-1.0,
1,878 stars, "Datomic-compatible APIs", history/time-travel confirmed). Neither is a
Postgres/MySQL feature. This remains exactly the gap Octo's hand-rolled Slice 9 fills.

### 5. Hybrid graph+vector over ACID relational as "common industry pattern for epistemic memory" — partially_true

Confirmed components:
- **Graphiti** (`getzep/graphiti`, Apache-2.0, 31,602 stars): README confirms "Facts have validity
  windows. When information changes, old facts are invalidated — not deleted", "Explicit
  bi-temporal tracking with automatic fact invalidation", "Episodes & Provenance: Every entity and
  relationship traces back to the episodes (raw data)". Backends: Neo4j 5.26, FalkorDB 1.1.2,
  Amazon Neptune, Kuzu (deprecated).
- **Beads** (`gastownhall/beads`, MIT, 27,776 stars, "A memory upgrade for your coding agent"):
  README confirms Dolt-powered ("Distributed graph issue tracker for AI agents, powered by Dolt",
  embedded + server Dolt modes, `bd dolt push/pull`), dependency graph, hash IDs, "Compaction:
  Semantic 'memory decay'".
- Octo itself (Postgres + pgvector + FalkorDB) is the third instance.

Not established: "for epistemic memory" as a *pattern*. No mature product markets an
epistemic-memory layer over a relational base. The lineage/metadata platforms all verified real —
OpenLineage (2,696 stars; "generic model of run, job, and dataset entities... extensible by
defining specific facets"), Marquez ("reference implementation of the OpenLineage API"),
DataHub (12,808 stars, "150+ integrations, column-level lineage", LinkedIn origin),
OpenMetadata (15,432 stars, MCP server, column/table/dashboard/pipeline lineage, PROV-O/OpenLineage
standards), Apache Atlas (2,152 stars), Egeria (925 stars, LF AI & Data; 261 code hits for
OpenLineage) — model **dataset/job lineage**, not beliefs or claims. The "epistemic memory" frame
is the researcher's synthesis, not a documented industry category. Partially true.

### 6. XLOG — partially_true (feature claims verified; maturity refuted; one factual sub-claim affirmatively false)

Verified against xlog.md/epistemic/overview and `BrainyBlaze/xlog`:

- `know`/`possible` modal operators — confirmed: "know p — is p true in every possible world?";
  "possible p — is p true in at least one possible world?"; "execution is GPU-backed".
- Stable-model semantics with selectable modes — confirmed: `faeel` ("the founded semantics and
  the default") and `g91` ("Gelfond-1991 semantics, the classical 1991 definition"); "A stable
  model is... an assignment of facts that justifies exactly itself"; world views; constraints.
- Dual license Apache-2.0/MIT — confirmed (LICENSE-APACHE + LICENSE-MIT in repo).
- Rust + CUDA, GPU execution — confirmed throughout README ("Implemented in Rust with custom CUDA
  kernels"; epistemic evaluation "on the GPU").

**Maturity refutation stands, on stronger grounds than the researcher had:** 5 stars, 0 forks,
4 contributors, CI (`production-build` on ubuntu-24.04) checks source only — no GPU runner;
single platform (README: "Public releases of XLOG are supported on Linux x86_64 with an NVIDIA
GPU and CUDA Toolkit 13.x"); crates.io `xlog-cli` has 356 total downloads across 4 versions;
no named users.

**Factual correction:** the researcher asserted "NO published releases" and "GPU builds manual and
LOCAL (CI checks source only)". The release part is affirmatively false: **4 GitHub releases**
(xlog-cli v0.5.0 2026-04-19 → v0.11.0 2026-07-29), 10 tags, 4 crates.io versions, a PyPI `pyxlog`
wheel, and a README section documenting "GitHub release binary install" ("Public release archives
are built with host-io"). The CI/source-only part is accurate. "Research prototype, not
production-ready" survives; "no releases" does not.

### 7. DataKlog / AAAI 25773 — partially_true (paper real and accurately described; name unverified)

- AAAI article 25773 is real: "Epistemic Disjunctive Datalog for Querying Knowledge Bases",
  Gianluca Cima, Marco Console, Maurizio Lenzerini, Antonella Poggi (Sapienza), Proceedings of the
  AAAI Conference on Artificial Intelligence, Vol. 37 No. 5 (AAAI-23), pp. 6280–6288,
  DOI 10.1609/aaai.v37i5.25773, published 2023-06-26.
- Abstract: proposes "a query language that combines Disjunctive Datalog rules with a modal
  epistemic operator" retrieving what is "true in every model of the KB" — the researcher's
  technical description is accurate.
- **"DataKlog" appears nowhere on the paper page**; GitHub search for `dataklog`/`data-klog` finds
  no such system. The paper is real; the product name is not established.

### 8. "Has someone built claims+evidence+revision+contradiction for content pipelines?" — refuted (no such product; negative-existence claim survives)

Genuine attempt to break it, and it holds:

- **Wikibase** (`wikimedia/mediawiki-extensions-Wikibase`, GPLv2 per COPYING) — confirmed the most
  mature claims-with-references system: DataModel docs state statements carry "mainSnak, rank,
  referenceRecords, qualifierSnaks"; "three possible ranks: Preferred, Normal, Deprecated";
  multiple preferred statements may coexist as "a disagreement (diverging population figures given
  by different sources)". Wikidata data CC0 confirmed. But: wiki knowledge base, no dual-axis
  bitemporality, not content-pipeline tooling.
- **Graphiti/Zep** — confirmed bi-temporal + automatic invalidation + episode provenance
  (31.6k stars), but agent conversation memory, not content claims.
- **Lemmalog** — experimental (0 releases), as established above.
- **Fini** — verified further than the researcher did: usefini.com/knowledge-atlas explicitly
  lists "Conflict detection: Two articles disagree. It catches it... Flags duplicates,
  contradictions, outdated content, and version mismatches... Surfaces them in a reconciliation
  dashboard". Proprietary SaaS, customer-support space, no claim/evidence data model. This
  *strengthens* the refutation: the closest commercial analogue exists and still is not
  content-pipeline tooling.
- **CMS revision models** — Payload confirmed (`_slug_versions` collection, "a _full_ copy of the
  document", drafts + autosave); Wagtail Revision model confirmed (31 code hits for
  `class Revision content_object`); MediaWiki GPLv2+ confirmed, revision table real; Sanity has
  document history (pricing page: "Review Changes: Complete history", "Full audit trail & History
  API", "Rollback releases") — the researcher's exact quote "Version-controlled - Complete
  document history" was not found in that wording; same substance. None has claim/evidence/
  contradiction semantics.
- **Lineage tools** — all verified real (see #5); all dataset lineage, not assertions.
- **arXiv 2606.04990** — real: "From Agent Traces to Trust: A Survey of Evidence Tracing and
  Execution Provenance in LLM Agents" (submitted 3 Jun 2026, v5 10 Sep 2026). Names no shipped
  product spanning evidence, revision and contradiction for claims.
- GitHub search for claims+evidence+contradiction+provenance surfaced only 0–1-star hobby repos
  (ScholarGraph, Veritas, TrustNode, policy-evidence-engine, evidence-integrity-engine) — nothing
  maintained or mature.

### Systems-reported corrections (beyond the claims)

- **Stardog "Data Provenance"** — the researcher's description is **verified**: Stardog Studio
  v1.20.0 introduced "Provenance, a new hub for viewing how your existing enterprise data sources
  breathe life into your Knowledge Graph... a simple way to see how the data sources that make up
  your Knowledge Graph align and populate the concepts in your data model"
  (stardog.com/blog/charting-data-provenance-in-studio). It is not surfaced on the current
  homepage/platform/docs navigation, which is likely why a quick pass missed it.
- **Dataship** — confirmed as reported: `dataship/dataship` (7 stars) + npm `dataship@0.8.4`,
  "Practical numerical analysis in javascript... the built-in library for dataship.io". Not a
  provenance system; misnamed in the brief as suspected.
- **Datomic license — unresolved.** datomic.com surfaces only "Datomic Pro EULA" / "Datomic Cloud
  EULA" links and calls it "the free database built on immutable values"; the local repo research
  doc claims Apache-2.0 all editions since Apr 2023. Vendor pages checked do not settle it;
  treat the license line as conflicting between sources.
- **Decap/Tina/Automerge/Yjs/C2PA/lakeFS/Materialize/Feldera** — all repos verified live with
  stated characteristics matching (Decap MIT 19.4k; Tina Apache-2.0 13.8k; Automerge MIT "compact
  compression format... sync protocol"; Yjs MIT 22.9k; c2pa-rs LICENSE-APACHE + LICENSE-MIT;
  lakeFS BUSL-1.1; Materialize BSL-1.1; Feldera "OPEN-SOURCE EDITION - MIT LICENSE" with a
  separate enterprise clause). Dolt "cell-level merge": docs say "cell-wise merge of data" — same
  substance, different wording. TerminusDB release is v12.0.7 (researcher said v12.0.5; v12.0.5
  superseded 2026-08-10).

## Bottom line for Octo

The report's load-bearing conclusions survive a hostile re-verification: no mature, maintained,
adopted system duplicates Octo's claims+evidence+revision+contradiction bitemporal design for
content pipelines; the Datalog/epistemic-reasoning engines that exist (Lemmalog, XLOG, Synalog)
are prototypes; the mature options (RDFox, Stardog, Wikibase, XTDB, Datomic/Datahike) each cover
one axis, not the combination. Three factual corrections carry forward: Synalog exists (tiny,
beta, different architecture), XLOG has releases (still a prototype), and Stardog's provenance
feature is real but buried.
