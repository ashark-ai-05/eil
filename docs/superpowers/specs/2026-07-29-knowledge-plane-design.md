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
| **No Postgres extensions** | No pgvector, no pg_search, no pg_trgm. Every mechanism below is stock SQL. |
| Deterministic and auditable | Same query + same corpus ⇒ same order, including ties. No LLM in the query path. |
| Cost minimal | Local models only. No per-query API spend. Re-embedding is the dominant recurring cost and must be avoided, not optimised. |
| Runs on a laptop (PGlite) and on a server | Two backends, one code path. Nothing may require a server process. |

**pgvector is now installable on PGlite** (`@electric-sql/pglite-pgvector` ships
0.8.1), so the zero-install premise is weaker than when the no-extension rule was
set. It does not change the decision: inside PGlite, native `bit_count` beats
pgvector's own operator because the WASM build has no SIMD, and integer Hamming
is bit-for-bit reproducible where float dot products are subject to SIMD
reassociation. pgvector becomes an *opportunistic* index — detected at startup,
never required. `pg_trgm` is genuinely unavailable on PGlite (verified).

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
recall regression. **The oversample factor is the control knob and it has a
measured curve behind it.**

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
Research on Onyx, Zoekt/tree-sitter, and OpenFGA/OpenTelemetry is still in
flight; those sections will be revised before implementation.

| Reference | What we take | What we reject |
|---|---|---|
| **Zoekt** | Its *ranking model* — symbol match, word-boundary, filename match, term count — which is portable even though its trigram index is not. Symbol extraction at index time. | The trigram index itself. `pg_trgm` is unavailable on PGlite and cannot represent `->`, `::`, `=>` anyway. |
| **Tree-sitter** | `tags.scm` symbol extraction for a definition index, and AST boundaries for *stable chunk identity*. | AST chunking **for accuracy** — measured a statistical tie with sliding windows, and function-level chunking was the worst of four strategies. |
| **SCIP / LSIF / stack-graphs** | — | All of it. Compiler-coupled, minutes-to-hours per repo. The measured agent gains attributed to symbol graphs come from compiler-free tree-sitter graphs at ~1/35th the cost. |
| **OpenFGA / Zanzibar** | The relation-tuple *model*, materialized locally into `acl_groups` at ingest. Zanzibar itself recommends denormalizing ACLs into the search index for exactly this filtering problem — EIL's existing pattern is right. | Running an OpenFGA server. |
| **Temporal** | Retry semantics: per-step retry policy, heartbeat-as-cursor-progress, and full-jitter backoff. | The server. It is mandatory, shard count is fixed at build time and unchangeable, and self-hosting is a documented biweekly-upgrade treadmill with no version skipping. That conflicts head-on with "runs on a laptop, no Docker." |
| **LangGraph** | Nothing for this spec. | As a durability layer: its own docs state nodes re-execute from the top on resume, "including any LLM calls, API requests, or interrupts," with no retry policy, no rate limiting, and checkpoints that accumulate with no GC. It is an agent-reasoning library, not a durable runtime. |
| **DBOS Transact** | The shape we imitate: durable steps checkpointed into *your own* Postgres, library-only, no separate server. | Taking the dependency now — a job table gets us the same guarantees for this workload. |
| **Langfuse / Phoenix** | Later, for the agentic layer. | As the home for *retrieval* evaluation. EIL's retrieval path has no LLM in it; an LLM-tracing tool is the wrong shape for recall@k over a labeled set. |
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

The `?|` ACL predicate is currently unindexable, forcing a second full scan on
every vector query. `audit_log` — the highest-volume table — has no index on
`at` while every metrics view groups by `date_trunc('day', at)`.

### 4.5 Instrumentation

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

### 4.6 Evaluation and feedback

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

### 4.7 Migration safety

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

### 5.3 Durable execution — job table, not Temporal

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

### 5.4 Secrets — needs your decision

There is **no scanning, redaction, or entropy check anywhere** in the ingest
path. Every `.env.example`, committed `.pem`, hardcoded key, and Confluence page
holding production credentials is indexed verbatim into `documents.body` and
served to agents through `get_doc`. Given that EIL's entire premise is feeding
org knowledge to LLMs, this needs an explicit decision, not a default. Options
are redact-at-ingest, detect-and-quarantine, both, or accepted-and-documented.

### 5.5 Extraction gaps (ordered by retrieval value)

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

### 6.2 Code: identifier tokenization and real executors

A `simple`-config `tsv_code` fed by camelCase/snake_case/path splitting, so
`retryHandler` indexes as `retryhandler` + `retry` + `handler`. Zoekt-style
weighting: A = symbol name, B = path and subtokens, C = content.

This gives the `symbol`/`path`/`exact` routes something real to execute against.
The `code_index` table added by ash-72 provides exact-identifier lookup but no
tokenization at all, so it answers `retryHandler` and not `handler`.

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

## 11. Open questions

1. **Secrets** (§5.4) — needs a decision before ingestion breadth work.
2. **`ingested_by` is the OS username**, not the viewer principal, and since
   every connector stamps `acl_groups: []`, it is the only ACL dimension
   operating inside a tenant. On a shared server every document is owned by the
   service account. The "phase-2 ACL syncer" does not exist. This is a
   prerequisite for any multi-user deployment and is not scoped here.
3. **Migration 0009's lock profile** — needs a staged rewrite before any large
   corpus is migrated.
4. Grounding research on Onyx, Zoekt/tree-sitter and OpenFGA/OTel is in flight;
   §3, §6.2 and §7 may be revised.
