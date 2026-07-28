# EIL knowledge plane — ingestion, storage, retrieval

Status: draft for review · 2026-07-29

Scope: the three planes that make EIL a knowledge layer. The agentic SDLC that
will run on top is **out of scope**; this spec only commits to the seams it
needs (§7). Those seams are cheap now and expensive to retrofit.

---

## 1. Constraints

Fixed by the product, not negotiable inside this spec:

| Constraint | Consequence |
|---|---|
| Target 1M–20M chunks, org-wide, single deployment | The linear vector scan must go. Everything is sized against 20M. |
| **No Postgres extensions** (policy, see below) | Every mechanism below is stock SQL. Extensions may be used opportunistically, never required. |
| Deterministic and auditable | Same query + same corpus ⇒ same order, including ties. No LLM in the query path. |
| Cost minimal | Local models only. No per-query API spend. Re-embedding is the dominant recurring cost and must be avoided, not optimised. |
| Runs on a laptop (PGlite) and on a server | Two backends, one code path. Nothing may require a server process. |

**The "no extensions" rule is a deployment-symmetry policy, not a technical
limit, and it should be held deliberately rather than inherited.** Two verified
corrections to the premise it was set under:

- **pgvector is installable on PGlite** (`@electric-sql/pglite-pgvector`, 0.8.1).
- **`pg_trgm` is too** — via `@electric-sql/pglite/contrib/pg_trgm` plus
  **constructor registration**, not a migration. Measured:
  `CREATE EXTENSION pg_trgm` fails on the default bundle (which is what an
  earlier draft of this spec tested and wrongly concluded from), but with the
  contrib import it succeeds, `similarity('retryHandler','handler') = 0.4`, and
  a `gin_trgm_ops` index builds. PGlite ships 33 contrib extensions.

Neither changes the decision, for reasons that are about *properties*, not
availability. Inside PGlite, native `bit_count` beats pgvector's own operator
because the WASM build has no SIMD, and integer Hamming is bit-for-bit
reproducible where float dot products are subject to SIMD reassociation — which
matters for the determinism contract. And §6.2's subtoken index makes `handler`
a first-class indexed token of `retryHandler` rather than a substring of it, so
trigram search is only needed for genuinely mid-token fragments (`etryHand`),
which agents essentially never issue. Extensions stay **opportunistic** —
detected at startup, never required.

---

## 2. The empirical basis

Every number below was measured on this machine against real PGlite and the real
vendored ONNX model, not taken from a blog post. They are the load-bearing facts.

**The vector arm is the binding constraint.**

| Approach @20k chunks × 384-d | Total | Per chunk |
|---|---|---|
| exact `float4[]` dot — *what ships today* | 5971 ms | 298.5 µs |
| binary Hamming, full scan | 26 ms | 1.30 µs |
| IVF probe 8/256 + Hamming | 3 ms | 0.17 µs |
| funnel: Hamming top-400 → exact rescore | 163 ms | 8.15 µs |

Storage: `float4[]` 30 MB vs `bit(384)` 1035 kB — **30× smaller**. At 20M chunks
that is 30 GB vs 1 GB, which is the difference between "needs a big server" and
"fits in page cache."

**Binary quantization alone is not safe at 384 dimensions.** Measured on EIL's own
corpus with the real MiniLM model, over 20 real queries:

| Strategy | recall@10 vs exact float32 |
|---|---|
| Binary Hamming only | 63.5% ❌ |
| Hamming top-40 → exact rescore (4×) | 95.5% |
| Hamming top-80 → exact rescore (8×) | 98.0% |
| **Hamming top-160 → exact rescore (16×)** | **100.0%** ✅ |

The published figure for binary quantization is ~95% retention, but that is at
1024+ dimensions. Shipping binary-only here would have been a silent 36-point
recall regression.

**Those numbers are for a FULL Hamming scan. Adding IVF cluster probing is a
second, larger, independent recall loss** — measured separately on 1337 real
chunks in 64 clusters:

| nprobe (of 64) | oversample 8× | oversample 16× | chunks scanned |
|---|---|---|---|
| 1 | 45.5% | 45.5% | 18 |
| 4 | 81.0% | 81.0% | 79 |
| 8 | 90.5% | 90.5% | 157 |
| 16 | 96.5% | 96.5% | 324 |
| 64 (all) | 100.0% | 100.0% | 1337 |

**Oversample is not the control knob — nprobe is.** 8× and 16× are identical at
every setting, which tells us something useful: once survivors are rescored
exactly, binary quantization costs nothing. *All* the loss is clusters not
probed. Fix the oversample at 8× and tune nprobe.

This corpus is too small to set nprobe from — 21 chunks/cluster means the true
top-10 scatter across many clusters, where at ~4400/cluster they co-locate. So
the mechanism is validated and the **parameter is explicitly uncalibrated**; §12.1
specifies the calibration procedure and the recall gate that replaces guessing.

**BM25 is computable in stock SQL.** `unnest(tsvector)` returns
`(lexeme, positions, weights)`, so per-chunk term frequency is
`array_length(positions,1)`. Verified. Real BM25 therefore needs only a
corpus-level document-frequency table — no extension.

**But BM25 must not be applied to the whole loose-OR candidate set.** Measured at
20k chunks: `ts_rank` 229 ms vs BM25 866 ms, because the loose-OR fallback matches
nearly the entire corpus. This is the same defect that hurts quality — see §6.1.

**The embedder discards ~⅔ of every chunk.** MiniLM-L6 stops at exactly 256
tokens; `MAX_CHARS = 3200` is ~800. Two 800-token chunks differing only in their
tails embed to **cosine 1.000000** — byte-identical vectors. This is a correctness
bug that caps the ceiling on every other retrieval improvement.

**The embedder is rebuilt on every query.** 1192 ms cold / ~270–300 ms warm versus
4 ms for a reused instance — 60–75× of avoidable latency on every search.

**The `english` config destroys code.** `retryHandler` is unreachable from
`retry handler` or `handler`; `if`/`for`/`i`/`is`/`not` are stopwords and vanish;
`src/retry/scheduler.py` is one opaque token so basename search fails;
`MAX_RETRIES` becomes `'max' + 'retri'` and matches any document containing both.

**Ranking is dominated by a metadata prior.** RRF scores are flat — 1.6% per rank
at `k=60` — while the tier/recency modifier spans 2.4×. A fresh curated document
85 ranks down outranks a stale raw one at rank 1, inside a 24-deep candidate
window. The modifier can reorder the entire result list independently of
relevance.

**Nothing above is currently measurable.** `docs/golden-queries.md` holds two
entries, both fixtures, and the only metric is set recall@10 — which cannot see a
result moving from rank 1 to rank 10.

---

## 3. Grounding in existing systems

Rather than invent, each decision is anchored to a system that already works.

**The strongest external result: ONYX — the leading open-source enterprise RAG
platform — deleted cross-encoder reranking from its retrieval path entirely
(Alembic `78ebc66946a0`, 2026-01-28) and runs no LLM in the query path.** Its
live pipeline is build-ACL-filters → strip-stopwords → one hybrid call →
post-query censoring. EIL's determinism thesis is not a compromise; it is where
the leading platform independently converged. Two further validations: ONYX
needs `normalize_linear` in Vespa plus a whole normalization pipeline in
OpenSearch to make score fusion work at all, a problem EIL's rank-based RRF
cannot have; and EIL's `embed_model`-stamped self-healing model switch replaces
ONYX's five-table `PRESENT`/`FUTURE` two-index swap protocol.

| Reference | What we take | What we reject |
|---|---|---|
| **Zoekt** | Its *ranking model*, with the actual constants (§6.2): symbol/basename 7000 exact / 4000 partial, word-boundary 500/50, symbol-kind 100×factor, atom bonus `(1−1/n)×400`, composed by **MAX not SUM**. Symbol extraction at index time. | The positional trigram index (3.5× corpus, needs app-side candidate verification). Also its `repoRank`/`docOrder` tiebreakers — at ×100/×10 against a ×10⁷ main score they are provably incapable of changing any decision. |
| **Onyx** | Two-gate dedup (timestamp before hash), 30-min poll overlap, `SlimConnector` as a first-class id-listing contract, ACL namespace prefixing, sticky `in_repeated_error_state`, `should_index()` as a pure predicate, ±1 neighbour chunk expansion, document sets as collections of *connectors*. | Celery + Redis + 8 worker pools; contextual RAG (LLM in the index path, off by default even there); score-based fusion; ACL denormalized to a second store. |
| **Tree-sitter** | `tags.scm` `@definition.*`/`@name` convention via **web-tree-sitter** (zero deps, pure WASM, offline once vendored), with the 7 grammars `detectLanguage()` already claims. | AST chunking **for accuracy** — a statistical tie with sliding windows, and function-level chunking was worst of four. Native bindings (node-gyp toolchain). `tree-sitter-wasms` (51.8 MB). `@reference.*` tags — 10–50× the volume of definitions at near-zero precision. |
| **SCIP / LSIF / stack-graphs** | — | All of it. Compiler-coupled, minutes-to-hours per repo. The measured agent gains attributed to symbol graphs come from compiler-free tree-sitter graphs at ~1/35th the cost. |
| **OpenFGA / Zanzibar** | The relation-tuple *model*, materialized locally (§4.5). EIL's denormalized-ACL-in-index approach is literally OpenFGA's documented recommendation for search at scale — confirmed, keep it. | Running a server; zookies/ZedTokens (they solve snapshot skew between two stores; EIL has one and writes ACL+body in one transaction); per-result Check; ListObjects (documented small-collection-only). |
| **Temporal** | Retry semantics: per-step retry policy, heartbeat-as-cursor-progress, and full-jitter backoff. | The server. It is mandatory, shard count is fixed at build time and unchangeable, and self-hosting is a documented biweekly-upgrade treadmill with no version skipping. That conflicts head-on with "runs on a laptop, no Docker." |
| **LangGraph** | Nothing for this spec. | As a durability layer: its own docs state nodes re-execute from the top on resume, "including any LLM calls, API requests, or interrupts," with no retry policy, no rate limiting, and checkpoints that accumulate with no GC. It is an agent-reasoning library, not a durable runtime. |
| **DBOS Transact** | The shape we imitate: durable steps checkpointed into *your own* Postgres, library-only, no separate server. | Taking the dependency now — a job table gets us the same guarantees for this workload. |
| **Langfuse / Phoenix** | Later, for the agentic layer. | As the home for *retrieval* evaluation. EIL's retrieval path has no LLM in it; an LLM-tracing tool is the wrong shape for recall@k over a labeled set. |
| **OpenTelemetry** | Traces only, for causality and cross-process agent context (§4.7). | OTel metrics as the metrics system. Prometheus's own docs disqualify it for per-request billing, which is what `usage_facts` is. |
| **pgvector** | Its column types as the migration target, so `bit(N)` + `float4[]` map cleanly later. | As a requirement. Opportunistic only. |

---

## 4. Plane: storage

Schema is first because both other planes depend on it.

### 4.1 BM25 apparatus

```sql
CREATE TABLE lexeme_stats (
  lexeme text PRIMARY KEY,
  df bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE corpus_stats (          -- single row
  n_chunks bigint NOT NULL,
  avg_len double precision NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chunks ADD COLUMN len int;   -- length(tsv), maintained on write
```

Refreshed on a schedule, not per write. Staleness costs a little ranking
accuracy, never correctness. Measured: 4573 distinct lexemes over 20k chunks →
**408 kB**, built in 4.5 s. Linear, so ~7 min at 20M chunks.

### 4.2 Code-aware lexical index

```sql
ALTER TABLE chunks ADD COLUMN tsv_code tsvector;   -- 'simple' config, split identifiers
CREATE INDEX chunks_tsv_code_idx ON chunks USING gin (tsv_code);
```

Not a generated column: the identifier splitting happens in TypeScript at index
time so query time can apply *the identical function*. Index/query tokenizer
asymmetry is the classic silent failure here, so both sides must call one
exported function, and a test must assert the symmetry.

### 4.3 Vector funnel

```sql
ALTER TABLE chunks ADD COLUMN sig bit(384);       -- sign of each dimension
ALTER TABLE chunks ADD COLUMN cluster_id int;
CREATE INDEX chunks_ivf_idx ON chunks (tenant, cluster_id)
  WHERE embedding IS NOT NULL;

CREATE TABLE ivf_centroids (
  embed_model text NOT NULL,
  cluster_id int NOT NULL,
  centroid float4[] NOT NULL,
  PRIMARY KEY (embed_model, cluster_id)
);
```

`sig` is computed in Node from the existing vector — free, no re-embedding.
Centroids come from k-means over a sample, rebuilt when the corpus doubles.
Keyed by `embed_model` so a model switch cannot silently mix spaces, matching
the existing `chunks.embed_model` discipline.

### 4.4 Indexes the audits found missing

```sql
CREATE INDEX documents_acl_groups_idx ON documents USING gin (acl_groups);
CREATE INDEX audit_log_at_idx ON audit_log (at);
```

`audit_log` — the highest-volume table — has no index on `at` while every
metrics view groups by `date_trunc('day', at)`.

Two notes on the ACL index, because both are easy to get wrong:

**The GIN index must use the default `jsonb_ops` opclass.** `jsonb_path_ops`
supports only `@>`, `@?` and `@@` — it does **not** support the `?|` existence
operator, and Postgres will silently decline to use it. The statement above is
correct as written; do not "optimize" the opclass.

**Adding the index is not enough on its own.** The predicate is
`d.ingested_by = $1 OR d.acl_groups ?| $2::text[]`, and that `OR` across two
different columns defeats the GIN index regardless. The fix is to fold the owner
into the array as a `user:<principal>` token at materialization time, so the
whole check becomes one indexable operation:

```sql
(d.acl_groups ?| $1::text[] AND d.tenant = $2 AND d.tombstoned_at IS NULL)
```

Worth benchmarking `text[]` + `&&` (GIN `array_ops`) against `jsonb` + `?|`
while making this change — smaller index, cheaper decode, identical semantics.

### 4.5 Authorization: local relation tuples

EIL's denormalized-ACL-in-the-index approach is **not a shortcut** — it is
precisely what OpenFGA documents as its recommended pattern for search at scale
("build a local index from `/changes`"), and Zanzibar's own paper describes the
`Expand` API as existing so clients can "build efficient search indices for
access-controlled content." Per-result `Check` and `ListObjects` are both
documented as small-collection-only. **Keep the pattern.**

What the current *flat array* cannot express, in severity order:

1. **Union-only algebra.** `?|` is an OR. But every real connector model is
   `container_grant AND doc_restriction` — Confluence needs space-View **and**
   passing the nearest page restriction; Jira needs BROWSE_PROJECTS **and**
   membership of the issue security level. An intersection of two group sets is
   not representable as a set of group tokens unless one is a subset of the
   other. Getting this wrong is a security bug, not a performance bug.
2. **Nested groups.** `?|` is a flat set intersection, so it works only if the
   viewer's token already carries the transitive closure. GitHub teams nest and
   inherit downward, so this is not hypothetical.
3. **Container inheritance.** Nothing walks space → page or project → issue.
4. **No "why can I see this?"** — no `Expand` equivalent, so grants are unauditable.

The fix is the Zanzibar *model* materialized locally — no server:

```sql
CREATE TABLE acl_tuples (            -- object#relation@subject
  tenant text NOT NULL,
  object text NOT NULL,              -- 'space:ENG' | 'repo:acme/eil' | 'doc:...'
  relation text NOT NULL,            -- 'viewer' | 'member' | 'parent' | 'restricted_read'
  subject text NOT NULL,             -- 'user:alice' | 'idp:eng' | 'group:acme/eng#member'
  source text NOT NULL,              -- asserting connector, for scoped invalidation
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, object, relation, subject)
);
CREATE TABLE acl_revocations (       -- push-based, fail-closed before the next sync
  tenant text NOT NULL, subject text NOT NULL, object text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, subject, object)
);
```

Two recursive CTEs (`acl_group_closure` over `member`, `acl_ancestors` over
`parent`, both `UNION` not `UNION ALL` so real AD membership cycles terminate)
feed a materializer that stamps `acl_groups` inside the existing upsert
transaction. Group grain by default; expand to `user:` grain **only** where an
intersection forces it, and fail closed when an intersection cannot be reduced —
otherwise a restricted page in a 5,000-member space becomes 5,000 array entries.

**Namespace group tokens.** EIL has no namespace discipline today, so a
Confluence group named `eng` and a Jira group named `eng` collide silently.
Onyx prefixes everything: `user_email:`, `group:`, `external_group:<source>_<name>`,
`PUBLIC`. Adopt the same. Also adopt its *active* demotion path: a document that
a permission sweep can no longer see becomes **private**, not deleted — the
reason may be "you lost access" rather than "it's gone," and that is recoverable.
EIL reaches owner-only today by never having stamped, which is the same end state
arrived at passively; the sweep should be able to demote deliberately.

**Scope discipline:** use each provider's *effective permissions* endpoint where
one exists (GitHub `/collaborators?affiliation=all`, Bitbucket effective
permissions) — they collapse inheritance for you. Reserve the tuple graph for the
two connectors that genuinely need AND-semantics: Confluence (space × page
restriction) and Jira (project browse × security level). Note Jira's Reporter /
Assignee / Project-Lead grants are *per-issue dynamic subjects*, so a
reassignment is an ACL change.

**Zookies are the wrong tool here and we skip them.** They solve snapshot skew
between a separate ACL store and a content store. EIL writes the ACL stamp and
the body in one transaction to one database, so that race does not exist. EIL's
real staleness is *connector lag* — Confluence changed, EIL hasn't polled — which
a consistency token cannot help with. `acl_revocations` is the correct
substitute: revocation is a push that fails closed immediately, re-grant may be
lazy.

### 4.6 Instrumentation

```sql
ALTER TABLE audit_log
  ADD COLUMN duration_ms int,
  ADD COLUMN ok boolean NOT NULL DEFAULT true,
  ADD COLUMN error text,
  ADD COLUMN route text,
  ADD COLUMN executor text,
  ADD COLUMN trace_id text;
```

`route` and `executor` are **already computed** in `searchDocs` and thrown away.
Persisting them costs nothing and is simultaneously the p95 story, the
arm-contribution story, and the raw material for eval replay.

`callTool` moves into `try/finally` so failures are audited too — today `audit()`
runs after the handler, so **only successes are ever recorded**, and an ACL
denial is indistinguishable from a zero-result search, polluting the one metric
the design calls the adoption killer.

Add `span_id text` alongside `trace_id`, and the same pair on `llm_calls`. That
column pair is the join key between the fact tables and traces (§4.7).

### 4.7 Telemetry: keep the facts, add the traces

**Adopt OpenTelemetry traces. Keep the SQL-views-over-facts design unchanged.
Skip OTel metrics entirely.** These are complementary and the failure mode would
be letting either impersonate the other.

The existing principle — "metrics are SQL views over facts, not a dashboard's
interpretation" — is not merely defensible, it is backed by Prometheus's own
documentation: *"If you need 100% accuracy, such as for per-request billing,
Prometheus is not a good choice."* `metrics.usage_facts` **is** per-request
billing. Traces are lossy by design too: head sampling cannot guarantee capture.
So anything that must be complete — every read for compliance, every token for
cost — stays in Postgres, unsampled.

But tables cannot express causality. `audit_log` can say a search took 900 ms;
it cannot say 700 ms of that was the vector arm's sequential scan because the
ACL predicate wasn't index-usable. That is what spans are for, and it is exactly
the current blind spot.

| Question | Home |
|---|---|
| Who read what, when, which tenant | `audit_log` — never sampled |
| What did it cost | `llm_calls`, `usage_facts` |
| recall@10 over the labeled set | `metrics.eval_runs` — a corpus property, no span to hang it on |
| p95 latency by route | `audit_log.duration_ms` + a SQL view — exact, whole population |
| **Why** was *this* search slow | **spans** |
| Where did the agent's request originate | **spans**, via MCP context propagation |

Join direction: one `SERVER` span per MCP tool call; write its `trace_id`/`span_id`
into the audit row in the same transaction. Grafana already provisions a Postgres
datasource — add a Tempo datasource and a data link on `audit_log.trace_id`. The
sampling asymmetry is a feature: 100% of calls in the table, `trace_id` populated
for the sampled subset.

Conventions, with two currency warnings: the **GenAI semantic conventions moved
out of the main semconv repo** into `semantic-conventions-genai`, and everything
in it is `Development` stability — so wrap attribute names in a thin local
constants module. There *are* applicable conventions:
`gen_ai.operation.name = retrieval` with `gen_ai.data_source.id` (the natural
per-arm hook), `embeddings`, `execute_tool`, plus MCP's `mcp.method.name`,
`mcp.session.id`, and `network.transport = "pipe"` for stdio. MCP propagates
trace context through `params._meta`, which is what lets an agent's trace
continue *into* EIL — the single most valuable thing tracing buys here.

Three hard constraints, all specific to EIL's process shape:

1. **A stdio MCP server must never write telemetry to stdout.** `ConsoleSpanExporter`,
   a stray `console.log`, or the OTel diag logger's default sink all corrupt the
   JSON-RPC framing on fd 1 and hang the client. **Land this as a test before any
   other OTel work.**
2. **`BatchSpanProcessor` drops spans when a CLI exits.** Use `SimpleSpanProcessor`
   or an exit hook that awaits `sdk.shutdown()`.
3. **Off by default, zero cost when disabled.** App code imports
   `@opentelemetry/api` only (no-op singletons when no SDK is registered); the SDK
   lives in `optionalDependencies` behind a guarded `await import()`, so a CLI
   invocation never pays tens of MB of module-graph evaluation. This is what
   protects "runs on a laptop, no Docker."

Rejected: the Prometheus pull exporter (a short-lived CLI and a per-client stdio
spawn present no stable scrape target, and concurrent servers would fight over
the port); OTel metrics as EIL's metrics system (Grafana already reads Postgres —
a second, sampled, less accurate path buys nothing); deriving `audit_log` from
spans or OTel logs (an audit trail that can drop records is not an audit trail);
and double-writing any number to both a fact table and an OTel metric — they will
diverge on different flush timing and you will spend an afternoon reconciling
them. Leave `enhancedDatabaseReporting` **off** in `instrumentation-pg`: it
attaches query parameters, which here are viewer principals and group lists.

### 4.8 Evaluation and feedback

```sql
CREATE TABLE eval_queries (
  id bigserial PRIMARY KEY,
  query text NOT NULL,
  tenant text NOT NULL DEFAULT 'default',
  origin text NOT NULL CHECK (origin IN ('logged','authored','synthetic')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE eval_qrels (            -- graded, keyed by STABLE DOCUMENT ID
  query_id bigint REFERENCES eval_queries(id) ON DELETE CASCADE,
  doc_id text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 0 AND 3),
  judged_by text NOT NULL,
  PRIMARY KEY (query_id, doc_id)
);
CREATE TABLE retrieval_events (      -- implicit relevance + future learning signal
  trace_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  tenant text NOT NULL,
  query text,
  returned jsonb NOT NULL,           -- [{doc_id, rank, score, arm}]
  fetched jsonb                      -- doc_ids later pulled via get_doc
);
```

Qrels key on `documents.id`, never on chunk offset. Labeling at chunk granularity
is the standard way people destroy an eval set the first time they re-chunk.

### 4.9 Migration safety

Migration 0009 is the cautionary example: a full `chunks` rewrite plus a PK swap
plus an immediately-validated FK, all inside one transaction, holding
`ACCESS EXCLUSIVE` throughout. At 20M chunks that is an outage, not a migration.

Rules for everything in this spec:
- New columns are nullable with no default (metadata-only, no rewrite).
- Backfills are batched and resumable, run *outside* the schema transaction.
- New indexes use `CREATE INDEX CONCURRENTLY` where the backend supports it.
- Any migration that rewrites a table says so in a header comment with an
  estimated lock duration.
- Add a checksum column to `schema_migrations` — editing an applied migration
  currently diverges environments silently.

---

## 5. Plane: ingestion

### 5.1 Correctness (all measured defects)

| Fix | Why |
|---|---|
| Hash covers metadata, not just `body` | A rename, move, URL change or **ACL-group change** with an unchanged body is currently a permanent no-op. A security-relevant field guarded by a hash that ignores it. |
| Code `updated_at` from the git commit date | `NULL` → `modifier()` applies `RECENCY_FLOOR`, so **every code document carries a permanent ×0.6 penalty**, silently cancelling the router's code-arm weighting. |
| Cursor-safe generator errors | The `try/catch` wraps only `upsertDocument`; an HTTP error inside the generator escapes the `for await` and skips `setCursor` entirely, discarding all progress. |
| Retry with full-jitter backoff | `sleep = random(0, min(cap, base·2^attempt))`, base 1 s, cap 60 s (AWS Brooker). Nothing anywhere retries today, so one 429 aborts a sync — and combined with the cursor loss above, produces an unbreakable livelock. |
| Per-chunk embed reuse | `upsertInTx` deletes and re-inserts every chunk on any edit, so a one-character typo fix re-embeds a 100-chunk runbook. `chunks.content_hash` is already computed and never used as a reuse gate. **This is the single largest recurring cost in the system.** |
| Timestamp gate **in front of** the hash gate | EIL hashes every body on every re-sync even when the source already said nothing changed. Onyx's two-gate order is strictly cheaper. Keep the hash as fallback for sources with unreliable `updated_at`, and copy the ordering rule: when the timestamp *advanced*, an equal hash must not veto the update. |
| 30-minute poll overlap (`window_start = last_end - 30min`) | The cursor is exact-boundary today. A source writing second-granularity `updated` values that commit out of order **will** drop documents. Free, because ingestion is hash-gated — re-seen docs are no-ops. Also: when the previous attempt failed mid-stream, reuse its window rather than advancing, or newly created entities are skipped. |

**A live snippet bug.** `ts/core/chunker.ts` writes `text = headingPath + "\n\n" + piece`,
and both snippet paths read that same column — `ts_headline(...)` over `text`, and
`String(row.text).slice(0, 240)` in `vecArm`. So every snippet spends its opening
characters on the breadcrumb. Measured on the shallow test fixture: **9–16% of the
240-char vector snippet**, and a real Confluence hierarchy
(`Space > Team > Runbooks > Payments > Retry`) is far worse. Onyx solves this by
building the enriched string at embed time and stripping it before returning
chunks. Either store `text` clean and enrich on the way into `tsv`/the embedder,
or strip the known prefix on read.

Related, from the same source: give the prefix a **budget with a content floor**.
Onyx drops the metadata suffix when it exceeds 25% of the chunk, then drops
contextual text, then drops the title — content always wins the last cascade.
EIL prepends unconditionally inside the same `MAX_CHARS`, with no floor.

### 5.2 Throughput

- **Batch upserts.** ~10 round-trips per document × 10k documents = ~100k
  serialized round-trips. Multi-row `VALUES`, or `COPY` for chunks.
- **`git cat-file --batch`** instead of one `git show` subprocess per file. At
  100k files that is 100k process spawns *and*, because the clone is
  `--filter=blob:none`, 100k individual lazy blob fetches over the network. The
  partial-clone optimization makes the first full ingest catastrophically slow.
- **Bounded backfill.** `SELECT ... WHERE embedding IS NULL` has no `LIMIT`; a
  first-run monorepo backfill pulls the entire corpus text into the Node heap.
- **Default repo excludes** — lockfiles, `dist/`, minified, vendored,
  generated protobufs. `RepoFilter` starts empty today.

### 5.3 `sync_state`: the table that unlocks scheduling

`sync_cursors (tenant, source, cursor)` is doing the work of Onyx's whole
connector-credential-pair with one text column, and `cursorKey()` already
overloads `source` with the scope selector. Promote it:

```sql
CREATE TABLE sync_state (
  tenant text NOT NULL, source text NOT NULL, scope text NOT NULL DEFAULT '',
  cursor text, checkpoint jsonb,             -- typed, resumable mid-entity
  refresh_freq interval, prune_freq interval,
  last_success_at timestamptz,               -- distinct from updated_at (see below)
  last_attempt_at timestamptz, last_pruned_at timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  in_repeated_error_state boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant, source, scope)
);
```

`last_success_at` separate from `updated_at` is what fixes the stale-cursor alert
that is currently defeated by the rot it detects — `setCursor` refreshes
`updated_at` unconditionally, so a connector failing *every* document holds its
cursor value (correct) while resetting its freshness clock to zero (wrong).

`should_index()` becomes a pure predicate over this row — testable with no
scheduler. And `in_repeated_error_state` must be **sticky**: not re-evaluated
while set, so a user's manual retry isn't instantly re-paused. That
counter-intuitive detail is the half people miss.

Also persist per-item failures rather than printing them: you cannot build a
repair pass over console output.

### 5.4 Durable execution — job table, not Temporal

A Postgres job table gives the guarantees this workload needs without a server:

```sql
CREATE TABLE ingest_jobs (
  id bigserial PRIMARY KEY,
  tenant text NOT NULL,
  source text NOT NULL,
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  last_error text
);
```

Claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. Attempts and `next_attempt_at`
implement the backoff; the cursor is the checkpoint.

**Why not Temporal**, given it models this problem almost perfectly: it requires
a server, its shard count is fixed at build time and cannot be changed without a
rebuild and data migration, backward compatibility is guaranteed only between
consecutive minor versions with releases every two weeks, and its own docs call
self-hosting "significant engineering and ongoing effort." Temporal Cloud has no
free tier ($100/month floor). Every one of those conflicts with "runs on a
laptop, no Docker." Revisit if ingestion outgrows a single worker.

### 5.5 Secrets — needs your decision

There is **no scanning, redaction, or entropy check anywhere** in the ingest
path. Every `.env.example`, committed `.pem`, hardcoded key, and Confluence page
holding production credentials is indexed verbatim into `documents.body` and
served to agents through `get_doc`. Given that EIL's entire premise is feeding
org knowledge to LLMs, this needs an explicit decision, not a default. Options
are redact-at-ingest, detect-and-quarantine, both, or accepted-and-documented.

### 5.6 Extraction gaps (ordered by retrieval value)

1. **Git history** — commit messages are where the Jira-key↔code link physically
   lives, and `normalizeCode` hardcodes `links: []`, so that edge can never form.
2. **Cross-source links** — no URL matcher exists at all, and Jira's structured
   `issuelinks` field isn't even requested. The link graph is EIL's
   differentiator over vector-only systems, and it is mostly empty.
3. **Jira fields** — assignee, labels, resolution, parent/subtasks, changelog.
   Comments are ingested but unpaginated, so long issues truncate at a shifting
   boundary.
4. **Confluence** — labels, comments, attachments; `created` is hardcoded `null`
   and `author` is actually the *last editor*, which is mislabeled data rather
   than missing data.
5. **`TICKET_RE` false positives** — `UTF-8`, `SHA-256`, `CVE-2021-44228` all
   become `jira:issue:*` edges, and the *same regex* routes queries, so searching
   `"UTF-8 encoding"` does a Jira lookup for a nonexistent ticket.

---

## 6. Plane: retrieval

### 6.1 Lexical: IDF-pruned candidates, then BM25

Two changes, in this order:

**Prune the query by document frequency before the scan.** The loose-OR fallback
ORs every term including `work`, which matches the whole corpus. `lexeme_stats`
lets us drop non-discriminative terms *before* touching `chunks`, which improves
precision and cost simultaneously — the measured 866 ms BM25 figure is entirely
an artifact of scoring everything.

**Then score survivors with real BM25**: `idf · tf(k1+1) / (tf + k1(1-b+b·len/avgdl))`,
with tf from `unnest(tsv)` and idf from `lexeme_stats`. `k1=1.2`, `b=0.75`.

Also: `setweight('A')` on the breadcrumb prefix — free at index time, currently
not done, so a title term counts exactly as much as one buried in body prose.
And fix the negation guard, which currently disables the loose fallback for the
whole query, reintroducing the zero-result bug it was added to fix.

### 6.2 Code: tokenization and a real scorer

Two independent defects. `ts/code-search.ts:47` matches with `ci.value = $4` —
a single exact equality, so `handler` cannot find `retryHandler`. And
`ts/code-search.ts:68` orders by `ci.path, ci.line_start, …` — **there is no
ranking at all; results come back alphabetically by path.**

**One tokenizer, called at index time and query time.** Asymmetry between the two
is the classic silent failure here, so this must be a single exported function
with a test asserting symmetry:

```ts
const ACRO  = /(?<=[A-Z]{2})(?=[A-Z][a-z])/;   // HTTPResponse -> HTTP|Response
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])/;        // retryHandler -> retry|Handler
const DIGIT = /(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;
// hard-split on non-alphanumerics, then ACRO, then CAMEL; digit splits are
// ADDITIVE (sha256Hash -> sha256, sha, 256, hash), lowercase, drop len < 2.
```

Requiring **two** uppercase before an acronym break is what makes this correct
where Lucene's `WordDelimiterGraphFilter` is not — Lucene yields `HTTPResponse`
as one token and splits `OAuth2Client` into `O|Auth2|Client`. Verified outputs:
`parseHTTPResponse → [parse,http,response]`, `IOError → [io,error]`,
`getURLFromID → [get,url,from,id]`, `MAX_RETRY_COUNT → [max,retry,count]`.

**Paths expand to every suffix**, which is what makes `scheduler.py` find
`src/retry/scheduler.py`: full path ∪ every suffix ∪ every segment ∪ basename ∪
basename-sans-extension ∪ subtokens.

Store the emitting rule as `match_class ∈ {exact, subtoken, path_suffix,
path_segment}` — that column is how we recover Zoekt's exact-vs-partial
distinction without a trigram index.

**Zoekt's scorer, in SQL.** The critical property is that it composes by **MAX
over matches, never SUM** — otherwise a file mentioning `handler` forty times in
comments beats the one file that defines `retryHandler`:

```sql
SELECT ci.doc_id,
       MAX( CASE ci.match_class WHEN 'exact' THEN 7000 WHEN 'path_suffix' THEN 7000
                                ELSE 4000 END
          + CASE WHEN ci.match_class = 'exact' THEN 500 ELSE 50 END
          + 100 * COALESCE(k.factor, 1) )
     + (1 - 1.0 / COUNT(DISTINCT ci.matched_term)) * 400 AS score
  FROM code_index ci
  LEFT JOIN symbol_kind_factor k ON k.kind = ci.symbol_kind
 WHERE ci.tenant = $1 AND ci.value = ANY($2::text[])
 GROUP BY ci.doc_id
 ORDER BY score DESC, ci.path, ci.line_start, ci.doc_id
```

`symbol_kind_factor` is a 12-row table transcribing Zoekt's factors (Class 10,
Struct 9.5, Interface/Type 8, Function/Method 7, Constant 5, Variable 4, else 1).
The existing `code_index_lookup_idx (tenant, value, kind, …)` already serves
`= ANY(...)` as index probes, so the match needs no new index. Zoekt's
`ScoreOffset`/`repoRank` arithmetic exists only to stop tiebreakers perturbing
the main score; a multi-column `ORDER BY` gives that for free.

**Do not apply IDF/BM25 to the code arm.** Zoekt shipped it, made it opt-in, and
documents why: *"idf can down-weight the score of some keywords too much,
leading to a worse ranking"* for keyword-style queries. BM25 (§6.1) is for the
**prose** arm; code gets the constant model. These are different problems.

**`simple` instead of `english` for `tsv_code`** — a one-word change that stops
stemming `retryHandler → retryhandl` and stops deleting `if`, `for`, `do`, `no`,
`on`, `is`, `t`, `s`, all of which are real code tokens. Verified.

**Prefix and suffix without trigrams**, both verified index-backed on PGlite:
`btree (value text_pattern_ops)` for `value LIKE 'sched%'`, and
`btree (reverse(value) text_pattern_ops)` for suffix matching. `reverse()` is a
core builtin. Only true mid-token infix remains uncovered.

**Symbol extraction** via web-tree-sitter (zero dependencies, pure WASM, offline
once the `.wasm` files are vendored) using the `@definition.*` / `@name`
convention. Two traps: only 14 tree-sitter repos ship a `tags.scm` at all, and
**`tree-sitter-typescript`'s is a supplement** — it has no `function_declaration`
or `class_declaration`, which live in the JavaScript grammar. Concatenate JS+TS
or silently miss most TypeScript symbols. `#strip!` and `#select-adjacent!` are
directives of the Rust `tree-sitter-tags` crate, not the query engine, so they
must be dropped or hand-implemented.

**Stop indexing whole lines.** `ts/ingest/codeindex.ts` adds an `export` entry
whose value is the entire trimmed source line, and a `literal` for every quoted
run ≥2 chars. Nobody queries an exact trimmed source line, so those rows are
pure weight — and they are what drove the 23.4% btree-key-limit failure rate.

### 6.3 Vector: the funnel

1. **Coarse** — probe the nearest *P* IVF clusters, rank by
   `bit_count(sig # $q)`. 0.17–1.3 µs/chunk.
2. **Oversample 16×** of the requested `k` (measured 100% recall@10; 8× gives
   98%, and the factor is configurable against the recall curve).
3. **Exact rescore** the survivors with the existing `float4[]` dot product.

At 20M chunks with 4096 clusters probing 32: ~156k chunks coarse-scanned,
projecting to ~200 ms on PGlite and ~70 ms native.

### 6.4 Fusion and ranking recalibration

- **MaxP chunk→doc aggregation** — measured **+5 to +6 nDCG points** in the
  literature, pure SQL, ~0 cost, and it structurally fixes cross-arm eviction.
  The cheapest quality win available.
- **Sweep `RRF_K` over {10, 20, 30, 60}.** `k=60` gives only 2.6× spread across
  100 ranks; it is calibrated for long candidate lists, not per-arm top-20s.
- **Rebalance the tier/recency modifier** so a metadata prior cannot outrank
  relevance evidence — currently 2.4× against RRF's 1.6%/rank.
- **Near-duplicate suppression** at cosine > 0.95.
- **A `strict + phrase` prose arm.** `websearch_to_tsquery` already emits `<->`
  for quoted input and the loose rewrite preserves it (`<->` binds tighter than
  `|`), but a phrase hit and a term hit currently land in the same arm at the
  same weight. Onyx boosts phrase 1.5× over term 1.0×; EIL gets the equivalent
  for free by adding a third list — same "appears in more lists ⇒ ranks higher"
  trick already used for `strict_hit`, no tuned constant.
- **A title arm at low weight.** The breadcrumb is currently *inside* chunk text,
  so title terms score at full content weight — precisely the failure Onyx names
  ("irrelevant titles normalized to a score of 1"). They weight title at 0.10.
- **Widen the candidate pool.** `limit * 3` = 24 documents per arm at `limit=8`
  is thin for RRF, which differentiates better on deep lists. Onyx retrieves
  1000 before its final cut of 50. Use `max(50, limit*6)`; the cost is linear
  and the cut already happens in Postgres.
- Move to **convex combination** over RRF once ~40 labeled pairs exist; it beats
  RRF in- and out-of-domain in the reference work.

### 6.5 Cheap wins

- **Embedder singleton** — 60–75× on every search. Key the cache on `.id`, not
  the provider name, so a model switch can't serve stale-space vectors.
- **Chunk size matched to the embedder window**, fixing the 256-token truncation.
- **Drop `CODE_OVERLAP_LINES`** — measured ≤0.5pp for code and net-negative for
  prose. It is buying nothing.
- **Structured filters** in the tool schema (source, repo, path, updated_after,
  tier). Every column exists; none is filterable. `docs/ingestion.md` already
  documents a `source:` filter that does not exist.
- **±1 neighbour chunk on `get_doc`.** `(tenant, doc_id, seq)` is the chunk PK,
  so fetching `seq±1` is one index lookup. This is what makes zero-overlap prose
  chunking safe — Onyx recovers cross-boundary context at query time rather than
  paying for overlap at index time.

### 6.6 Reranking — a seam, not a feature

Off by default, behind a flag, and **gated on eval**. The honest number is ~1
point absolute recall@20, and rerankers fail to help at *any* depth in 11–15% of
cases. `Recall@50 − Recall@10` *is* the maximum possible reranker gain — measure
that gap before spending anything. Keeping it flag-off also preserves the
exact-list golden assertions that EIL's determinism uniquely allows.

### 6.7 Embedding model

`granite-embedding-small-english-r2`: +9 BEIR over MiniLM, 8192-token context
(which fixes the truncation bug outright), Apache-2.0, 52 MB, and **still 384
dimensions — no schema change, no `bit(N)` width change**. A second
code-specialized arm (`gte-modernbert-base`, +25 CoIR) is a later, optional step
justified only by eval.

---

## 7. Provisions for the agentic layer

Built into the three planes, not deferred:

- **`trace_id`** threaded through `callTool` into `audit_log`, so one agent task
  spanning many calls is reconstructable.
- **Chunk-level provenance** in results — `seq`, `heading_path`, line range — so
  an agent can cite and navigate instead of paging blind 8 KB windows.
- **Confidence metadata**: `top_score`, `score_gap`, `n_above_threshold`,
  `arms_contributing`. This hands the agent the "should I search again?" signal
  that Self-RAG/CRAG loops spend LLM tokens to compute, deterministically and
  for free.
- **`retrieval_events`** — query → results → subsequent `get_doc`. Simultaneously
  implicit relevance feedback, eval material, and the future learning signal.
- **A budget/quota hook** at the `callTool` choke point.
- **`REGISTRY`/`callTool` stays the mount seam.** It already works.

Response budget: default `top_k` 8–10, snippets 200–400 tokens, **total response
≤4000 tokens**. Design to that, not to the 25k MCP cap — the cautionary case is
an official MCP server costing 42k tokens before doing any work.

---

## 8. Evaluation — the gate on everything else

Nothing in §6 may be tuned before this exists.

- **150–200 queries.** ~50 replayed from real `audit_log` traffic, ~50 authored,
  ~100 synthetic from documents. Sizing: 50 queries detects only δ ≥ 0.10;
  150–200 detects δ ≈ 0.05.
- **Metrics: Recall@50 and Recall@10 as a pair, plus nDCG@10.** Recall@50 is
  headroom (moved by embedder/BM25/chunker), Recall@10 is delivered (moved by
  fusion/reranker), and the gap between them bounds any reranker's value.
- **Pointwise graded judging** (0–3), not pairwise — pairwise verdicts flip on
  reordering in 10–30% of comparisons. LLM judges reach Kendall τ 0.89–0.94 for
  *system ranking*, which is the only question we ask.
- **Pooled judging**: run all variants, pool the union of top-20, judge once,
  report `judged@10` thereafter. Below ~0.8, the score is untrustworthy.
- **Paired permutation test**, 10,000 shuffles. Never call δ < 0.01 nDCG a win.
- **Metrics in TypeScript** (they live in vitest and CI), cross-validated once
  against `trec_eval` on BEIR SciFact to 4 decimals. If they don't match,
  everything downstream is fiction.
- **`RBO(baseline, current, p=0.9)`** as a drift alarm. EIL's determinism makes
  this possible where most systems can't — a clean refactor gives exactly 1.000.

Synthetic-query caveat: a query generated from chunk *C* lexically echoes *C*,
inflating both BM25 and whatever chunker produced *C*. So synthetic queries
**cannot** be used to compare chunkers, which is one of the things we want to
compare. Generate from N documents, paraphrase in a second pass, and never let a
generated qrel be the only qrel.

---

## 9. Sequencing

| # | Step | Gate |
|---|---|---|
| 0 | Instrumentation: `audit_log` columns, `try/finally`, `trace_id`, `retrieval_events`, missing indexes | none — nothing else is measurable without it |
| 1 | Ingestion correctness: metadata hash, code timestamps, cursor safety, retry/backoff, per-chunk embed reuse | 0 |
| 2 | Eval harness + labeled set (replayed from step 0's logs) | 0, 1 |
| 3 | Cheap retrieval wins: embedder singleton, chunk/window match, drop code overlap, MaxP, filters | 2 measures each |
| 4 | Storage: `sig`/`cluster_id`/`ivf_centroids`, `lexeme_stats`, `tsv_code` | — |
| 5 | Retrieval substance: vector funnel, BM25, code executors, fusion recalibration | 2 proves each |
| 6 | Ingestion breadth: git history, cross-source links, Jira/Confluence fields | — |
| 7 | Optional, eval-gated: reranker, second embedder, learned sparse arm | 5 shows headroom |

Step 0 before step 2 is deliberate: the labeled set bootstraps from real logged
queries, which requires the instrumentation to exist first. It is also why the
golden-queries file has sat at two entries — hand-authoring was never going to
work.

---

## 10. Explicitly not building

Each of these spends LLM tokens on something the calling agent already does
better with full task context, or that a deterministic method captures at ~0.1%
of the cost:

HyDE (gain concentrated on sparse, +4.0% dense, degrades well-formed queries) ·
LLM query expansion inside EIL (measured negative-to-minimal on unfamiliar
vocabulary — and an enterprise corpus is by definition unfamiliar) ·
Self-RAG/CRAG/Adaptive-RAG loops (steal the evaluator signal instead, see §7) ·
Microsoft GraphRAG proper (50× indexing cost; EIL already has free, exact, typed
edges that GraphRAG pays to hallucinate approximations of) · memory layers
(full-context baseline beats them on their own published tables) · RAPTOR ·
semantic/breakpoint chunking (refuted by two independent evaluations; worst
recall in Chroma's table) · function-level-only code chunking (worst of four,
Cliff's δ = −1.0) · SCIP/LSIF/stack-graphs · ColBERT as first stage · IVFFlat
(centroids rot under continuous ingest) · any API reranker · `pg_search` /
`pg_textsearch` / VectorChord / pgvectorscale as hard dependencies.

---

## 11. Decisions

The four questions that were open. Three have recommendations; one genuinely
needs you.

### 11.1 Secrets — **NEEDS YOUR DECISION**

Nothing else here is blocked on it, but ingestion breadth (§5.6) is. There is no
scanning, redaction, or entropy check anywhere; every committed `.pem`,
`.env.example`, and credential-bearing Confluence page is served verbatim to
agents via `get_doc`.

**Recommendation: detect + quarantine + redact-on-serve.** Scan at ingest with a
rule set (known credential shapes: AWS keys, PEM blocks, JWTs, `postgres://`
URLs, plus a Shannon-entropy threshold on long tokens). Store the original body
unchanged — you need it to remediate, and destroying it makes false positives
unrecoverable — but stamp `secret_findings jsonb` on the document, exclude those
documents from retrieval by default, redact matched spans in `get_doc` output,
and surface the list in `eil audit`. That gives a remediation worklist rather
than silent loss, and it fails closed.

The cheaper option (accept + document) is defensible only if this index will
never hold real production Confluence. Say which.

### 11.2 `ingested_by` and the empty ACL — **fix in step 1, scoped here**

`ingested_by` is `userInfo().username` (the OS user of the ingesting process),
and every connector stamps `acl_groups: []`. On a shared server every document
is owned by the service account and visible to nobody else. This is not a
future concern; it makes the fail-closed ACL *vacuous in the only deployment
where it matters*.

**Decision: thread the `Viewer` into `upsertDocument` and stamp
`user:<principal>` as an `acl_groups` token (§4.5), in step 1.** The full
tuple-materializer (nesting, inheritance, intersections) stays a later step, but
the *shape* — one namespaced token array, owner included, single `?|` predicate —
lands now so nothing has to be re-migrated later.

### 11.3 "No extensions" — **keep it, as a stated policy**

§1 shows both pgvector and `pg_trgm` are reachable on PGlite. Keep the rule
anyway, for two reasons that survive the correction: integer Hamming is
bit-for-bit reproducible where float SIMD is not, and deployment symmetry means
one code path rather than a matrix. **Restated as policy:** extensions may be
*detected and used opportunistically*; no feature may *require* one. Every
capability must have a stock-SQL implementation that is the tested default.

### 11.4 Migration 0009's lock profile — **restage before any real corpus**

0009 does a full `chunks` rewrite plus a PK swap plus an immediately-validated
FK in one transaction under `ACCESS EXCLUSIVE`. At 20M chunks that is an outage.
It is already merged, so this is a *forward* fix: ship `0012_restage_0009.sql`
documenting the hazard, and a `db migrate --staged` path that performs the same
end state via batched `UPDATE`, `CREATE UNIQUE INDEX CONCURRENTLY` +
`ADD PRIMARY KEY USING INDEX`, and `NOT VALID` FKs validated out of band. Any
deployment whose `chunks` table exceeds ~1M rows must use it.

---

## 12. Migration sequence

Numbers are fixed here so parallel work cannot collide. `0009`–`0011` exist.

| # | File | Contents | Rewrite? |
|---|---|---|---|
| 0012 | `instrumentation.sql` | `audit_log`: `duration_ms, ok, error, route, executor, trace_id, span_id`; index on `at`; `retrieval_events`; same trace columns on `llm_calls` | no — nullable adds |
| 0013 | `acl_index.sql` | GIN `jsonb_ops` on `documents.acl_groups`; `documents.acl_synced_at` | no |
| 0014 | `sync_state.sql` | `sync_state` (§5.3), backfilled from `sync_cursors`; keep the old table one release for rollback | no |
| 0015 | `eval.sql` | `eval_queries`, `eval_qrels` | no |
| 0016 | `bm25.sql` | `lexeme_stats`, `corpus_stats`, `chunks.len` | **batched backfill** |
| 0017 | `code_tokens.sql` | `chunks.tsv_code` + GIN; `code_index.match_class`, `matched_term`; `symbol_kind_factor` seed; drop `kind IN ('export','literal')` rows | **delete + backfill** |
| 0018 | `vector_funnel.sql` | `chunks.sig varbit`, `chunks.cluster_id`, partial index, `ivf_centroids` | **batched backfill** |
| 0019 | `acl_tuples.sql` | `acl_tuples`, `acl_revocations`, closure/ancestor matviews | no |

**`varbit`, not `bit(384)`.** A fixed width forces a schema migration the day a
second embedder with different dimensionality arrives (§6.7 contemplates a
768-dim code arm). `bit_count` works on `varbit`; XOR between different widths
errors, but every query already filters `embed_model` first, so widths are
uniform within any comparison. This costs nothing now and removes a migration later.

**Backfill rule for all three rewriting migrations:** the DDL ships in the
migration; the data move ships as a resumable CLI command
(`eil backfill <name> --batch N`) that processes by primary-key range and
records progress, so it can be interrupted and is safe to run against a live
system. No migration file performs an unbounded `UPDATE`.

### 12.1 IVF calibration — the procedure that replaces a guessed nprobe

`nprobe` is **not** a constant in this spec. It is an output of a measurement,
re-run when the corpus doubles:

1. `nlist = round(sqrt(n_chunks))`, clamped to [64, 16384].
2. Build centroids by spherical k-means over a 200k-chunk sample, 25 iterations,
   seeded deterministically (k-means++ with a fixed seed — the corpus must not
   reorder between runs).
3. Sample 200 real queries from `audit_log`.
4. For nprobe ∈ {1, 2, 4, 8, 16, 32, 64, 128, 256}, measure recall@10 against a
   full exact scan.
5. **Gate: adopt the smallest nprobe with recall@10 ≥ 0.98.** If none reaches
   0.98 at nprobe ≤ 10% of nlist, IVF is not viable at this corpus shape — fall
   back to full Hamming scan and record why.
6. Persist the curve to `metrics.ivf_calibration` and fail CI if a later run
   drops below the gate.

Oversample is fixed at 8× and is not a tuning knob (measured: no effect).

---

## 13. Work breakdown

Each step lists the files, the acceptance criterion, and how it is proven. "Done"
means the criterion is met by a test that fails without the change.

### Step 0 — instrumentation *(migration 0012, 0013)*

`ts/tools.ts` (wrap `callTool` in try/finally; mint `trace_id`; audit failures,
denials and invalid-argument rejections) · `ts/search.ts` (persist `route` and
`executor`, already computed and discarded; distinguish ACL-denial from
zero-result in `resultCount`) · `ts/quality.ts` (persist `integrity()` and
`drift()` to a table rather than stdout) · `observability/grafana` (contact
points, `noDataState: NoData`).

**Acceptance:** a failing tool call produces an `audit_log` row with `ok=false`
and a populated `error`; p95 by route is answerable in SQL; an ACL denial does
not appear in `vw_zero_results`. **Proven by** a test asserting each.

### Step 1 — ingestion correctness *(no migration)*

`ts/contracts/models.ts` (hash covers title, url, hierarchy, aclGroups,
updatedAt) · `ts/ingest/code.ts` (git commit date → `updatedAt`; ticket keys and
imports → `links`) · `ts/ingest/pipeline.ts` (cursor-safe generator errors;
timestamp gate before hash gate; 30-min poll overlap) · `ts/connectors/auth.ts`
(full-jitter retry) · `ts/store.ts` (per-chunk embed reuse via the existing
`content_hash`; thread `Viewer` → `ingested_by`) · `ts/core/chunker.ts` (store
`text` clean; enrich at index/embed time).

**Acceptance:** a rename with unchanged body propagates · a 429 on page 40 of
200 does not lose pages 1–39 and the run resumes · editing one chunk of a
100-chunk document re-embeds exactly one · snippets contain no breadcrumb ·
code documents carry a real `updated_at`. **Proven by** one test each; the retry
test uses a fake connector that fails deterministically at a fixed offset.

### Step 2 — evaluation harness *(migration 0015)*

`ts/eval/metrics.ts` (recall@k, nDCG@k, MRR, judged@k, RBO — 10–30 lines each) ·
`ts/eval/harness.ts` (runs the production path, pooled judging, writes
`eval_runs`) · `eval/stats.py` (~100 lines: paired permutation test, and a
one-time cross-check of the TS metrics against `trec_eval` on BEIR SciFact).

**Acceptance:** TS metrics match `trec_eval` to 4 decimals · ≥150 labeled queries
with ≥50 replayed from real `audit_log` traffic · a deliberate ranking regression
is detected at p < 0.05. **Bootstrapping note:** until step 0's logs accumulate,
seed with authored + synthetic queries and mark `origin`, so the mix is auditable
and synthetic-only conclusions are visibly flagged.

### Step 3 — cheap retrieval wins *(no migration)*

Embedder singleton keyed on `.id` · `MAX_CHARS` matched to the embedder window ·
drop `CODE_OVERLAP_LINES` · MaxP chunk→doc aggregation · structured filters in
the tool schema · ±1 neighbour chunk on `get_doc` · confidence metadata in
results · widen the candidate pool to `max(50, limit*6)`.

**Acceptance:** every item is measured through step 2 and kept only if nDCG@10
does not regress; the embedder change is proven by a latency assertion
(< 20 ms warm). Items that fail to help are **reverted, not kept "because they
should work."**

### Step 4 — storage for scale *(migrations 0016, 0017, 0018)*

Schema plus the three resumable backfills, plus the IVF calibration run.

**Acceptance:** all backfills resume correctly after `SIGINT` · calibration
produces a curve meeting the §12.1 gate · migrations apply to a populated
1M-row fixture within a documented lock budget.

### Step 5 — retrieval substance *(no migration)*

Vector funnel · IDF-pruned BM25 (prose) · Zoekt scorer + subtoken tokenizer
(code) · fusion recalibration, including the `RRF_K` sweep and rebalancing the
tier/recency modifier against RRF's 1.6%/rank.

**Acceptance:** each lands as its own commit with its own eval delta and a paired
permutation p-value. **A change with p ≥ 0.05 does not merge.**

### Step 6 — ingestion breadth · Step 7 — eval-gated options

As §9. Step 7 items require a demonstrated `Recall@50 − Recall@10` gap first.

---

## 14. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **IVF recall never reaches 0.98 at a useful nprobe** | Medium | High — the whole scale story | §12.1 step 5 has an explicit fallback to full Hamming scan, which still buys 230×. Measure at step 4, before step 5 depends on it. |
| Subtoken expansion explodes `code_index` | **High** — already 122 rows/file before subtokens | Medium | Cap subtokens per row; drop `export`/`literal` whole-line rows (§6.2) which are pure weight; measure rows/file before and after and set a budget. |
| `tsv_code` silently missing on rows written by a path that forgets it | Medium | High — silent recall loss | It cannot be a generated column (Postgres requires IMMUTABLE; the tokenizer is TS). Add an `integrity()` check: code chunks with `tsv_code IS NULL`. |
| The eval set overfits to 150 queries | Medium | Medium | Pooled judging with `judged@10` reported every run; never call δ < 0.01 a win; hold out 20% of queries. |
| Synthetic queries flatter the chunker that produced them | **High** — structural | Medium | Generate from N documents and label all N; never let a generated qrel be the only qrel; do not use synthetic queries to compare chunkers at all. |
| Step 1's hash change forces a full re-ingest | **Certain** | Medium | Intended, but it must be *scheduled*: the metadata hash differs for every existing row. Pair it with the per-chunk embed reuse so the re-ingest does not also re-embed. Ship them in the same commit. |
| Embedder upgrade invalidates every vector | Certain when taken | Medium | `embed_model` stamping already degrades to FTS-only and self-heals. Re-embed from stored chunk text, never by re-running connectors. |
| Backfills run against a live system | Medium | High | Resumable, PK-range batched, no unbounded UPDATE in any migration file. |

---

## 15. Known unknowns

Stated so nothing here is mistaken for settled:

1. **nprobe at real scale** (§12.1). Mechanism validated, parameter not.
2. **BM25's actual quality delta.** The 866 ms figure is a cost measurement, not
   a quality one. IDF pruning should improve both; neither is measured.
3. **Whether the tier/recency modifier helps at all.** It has never been
   evaluated against ground truth. It may be worth 0.
4. **Chunk size.** ~800 tokens vs Onyx's 512 is a real tradeoff and currently a
   guess in both directions.
5. **Reranker headroom.** Unknown until `Recall@50 − Recall@10` is measured.
6. **Whether `granite-embedding-small-english-r2` beats MiniLM *on this corpus*.**
   +9 BEIR is a benchmark claim, not a measurement here.

Every one of these is closed by step 2 existing. That is the argument for its
position in the sequence.
