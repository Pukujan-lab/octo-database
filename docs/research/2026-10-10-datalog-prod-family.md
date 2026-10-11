# Datalog-in-production family (octo-db research)

Date: 2026-10-10. Note: web search budget exhausted (200/200); remaining verification via GitHub API and direct WebFetch of primary sources.

## Systems (verified against primary sources)

### Tier 1 - commercial / mature

- **Datomic** (Nubank) - append-only fact database; Datalog (EDN) query engine; datoms (E,A,V,Tx,Op) tied to monotonic tx t; retraction = append, never delete; as-of/since/history are native TRANSACTION-time filters. No native valid time. Apache-2.0 all editions since Apr 2023. Production at Nubank; 10+ yr ecosystem. docs.datomic.com
- **RDFox** (Oxford Semantic Technologies; Samsung acquired OST) - in-memory RDF store + Datalog/SWRL + OWL 2 RL; parallel semi-naive; commercial license (free eval). Named users Dow Jones, Siemens, Samsung, Inserm, Yale. No temporal, no K.
- **Materialize** - streaming IVM DB in Rust on Timely/Differential Dataflow. SQL not Datalog. BSL 1.1 (Apache-2.0 after 4 yr). $100M raised. No bitemporal/K.
- **LogicBlox / LogiQL** - commercial deductive DB (Datalog-descendant). Acquired Predictix 2014, Infor 2016; retail planning production. Proprietary.
- **XTDB v2** (JUXT) - native bitemporal SQL (SQL:2011 valid + system time). MPL-2.0, ~3.1k stars. Production case studies (energy VPP, KYC). SQL/XTQL not Datalog. Closest open native-bitemporal analogue.
- **Datahike** (replikativ) - Datomic-compatible durable Datalog (Clojure/JVM), time travel. EPL-1.0, 1.9k stars. Production: Swedish Public Employment Service (JobTech Taxonomy), Stub accounting SA.

### Tier 2 - solid OSS, moderate maturity, no clear commercial production

- **CozoDB** - relational-graph-vector DB, Datalog (CozoScript), Rust. MPL-2.0, 4.1k stars. Backends: mem/SQLite/RocksDB/Sled/TiKV - NO Postgres. Pre-1.0. No named users.
- **Feldera** - incremental compute for arbitrary SQL (DBSP, VLDB'23). MIT, 2.1k stars.
- **Souffle** - Datalog-to-C++ compiler (Oracle Labs origin). UPL-1.0, 1.2k stars. Static-analysis tool, not a DB.
- **DDlog** (VMware Research) - incremental Datalog to Rust on differential dataflow. MIT, 1.5k stars. Production: ovn-northd-ddlog in OVN v21.06.0, REMOVED in OVN v24.03.0. Repo archived Jul 13 2026.
- **Mangle** (Google-origin, now Codeberg/TauCeti) - Datalog extension with temporal knowledge graphs. Apache-2.0, 3.0k stars, no releases. Not official Google product.
- **Nemo** (TU Dresden) - Datalog + existential rules, RDF, in-memory. Apache-2.0/MIT, 305 stars, KR'24 paper, "unstable".
- **Scallop** - neurosymbolic Datalog with generalized provenance semirings. MIT, 518 stars. Research-grade.

### Tier 3 - experimental / archived / niche

- **XLOG (BrainyBlaze/xlog)** - GPU logic language (Rust+CUDA): Datalog + epistemic know/possible over multiple stable models. Apache-2.0/MIT. 5 stars, no releases, Linux+NVIDIA only. Not production.
- **Lemmalog (JordyZomer)** - Rust Datalog for LLM agent memory: bi-temporal (valid_from/valid_to/asserted_at), provenance semirings, scoped retraction, MCP server. MIT, 329 stars, 47 commits, no releases. Author calls it experimental.
- **Synalog / SynaLinks** - Synalog = "Datalog-family semantic layer with dynamically created entities" for agents (adjacent prior art). SynaLinks itself = Keras-style neurosymbolic LM framework, Apache-2.0, 463 stars, beta.
- **pg_mentat (Greg Burd)** - Datomic model + Datalog compiler inside Postgres (pgrx/Rust, PG13-18). Apache-2.0. 21 stars, first release May 2026, GitHub mirror archived Sep 26 2026 (Codeberg upstream).
- **TerminusDB** - git-like versioned document/graph DB with WOQL (Datalog-family query lang). Apache-2.0, 3.4k stars, v12 by DFRNT. No named production adopters.
- **Mozilla Mentat** - archived 2018, Apache-2.0, 1.7k stars. Ancestor of pg_mentat.
