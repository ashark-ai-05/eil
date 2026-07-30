# EIL-layer demo — design

**Date:** 2026-07-31
**Status:** built. See "What changed during implementation" at the end.

A 15-minute demonstration of the knowledge plane alone — ingestion, indexing,
retrieval, cost, governance, observability — for a room of engineers and
executives who **already run per-source MCP servers** for Confluence, Jira and
Bitbucket.

This is a different talk from the existing `demo/run.mjs`, which demonstrates
gated requirements elaboration. That demo and its narration stay where they are;
this one is additive.

---

## The positioning

> You have a pipe to each system. This is the index across them — one ranked
> answer, no model in the retrieval path, one ACL gate, one audit table.

**EIL is not an orchestrator above the audience's MCP servers.** It has its own
connectors (Confluence REST/CQL, Jira JQL, `git clone`/Bitbucket API, ELK) and
never calls another MCP server. Describing it as a "unified brain above your
pipes" is factually wrong about this codebase, and an engineer who then reads
`ts/ingest/` will discount the rest of the talk. It sits *beside* those servers
and replaces the per-source pattern for retrieval.

## Claims that must be stated accurately

Each of these was checked against the code. Getting them wrong on stage is the
cheapest way to lose the engineering half of the room.

| Do not say | Say instead | Evidence |
|---|---|---|
| Overlapping line-windows for everything | Code gets line-windows; prose gets heading-aware sections. Different shapes, different deterministic chunkers. | `ts/core/chunker.ts:86` branches on `doc.source === "code"` |
| "Two arms, fused" | Four lexical arms plus a vector arm: `fts_prose`, `fts_prose_loose`, `fts_code`, `fts_code_loose`, `vec` | `ts/search.ts:211`; the `executor` field names them on screen |
| `vw_cost_per_run` proves exact ROI | `llm_calls` is **empty** — that is the number | `migrations/0006`; an EIL-only run makes no model calls |
| Show `vw_spend_daily` | Do not. It reads `metrics.usage_facts`, which has no writer outside a test. | `migrations/0005_metrics.sql:88` |
| Open the network tab | MCP is stdio. Two-phase is visible in `audit_log` / `vw_two_phase`. | `ts/mcp-server.ts` |
| Log in as a restricted profile | Change `EIL_USER_GROUPS`. Enforcement is real SQL; identity is local. | `ts/search.ts:88` `localViewer()` |
| ACL stamped from your sources | Real and fail-closed, but **fixture-fed** — no connector stamps groups yet. Volunteer this. | known gap, connectors not enforcement |

The cost line, stated honestly, is stronger than the fabricated one:

> Forty searches. The table that records model spend has nothing in it. That is
> not missing instrumentation — that is where the money did not go.

## The question the demo is built around

> How stale can the presettlement view be before an order is rejected?

The answer exists only if all three sources are indexed:

| Source | Contribution |
|---|---|
| Confluence `ptrd-4` — Market Access Controls | The rule: a control that cannot be evaluated has not passed, so the order is rejected |
| Jira `PTR-415` | The number everyone agreed on — 1s |
| `demo/repo/ptc-gateway/src/creditCheck.ts` | `MAX_VIEW_AGE_MS`, the line that enforces it |

Measured: scoped to Confluence it returns the rule and nothing else; unscoped it
puts the code first, the ticket second and the obligation fourth, with all three
sources in the top four. That contrast is step 1.

The originally-specified question — *why does ptc-gateway reject when it cannot
complete the credit check* — was tried first and rejected. It is phrased in the
wiki's own vocabulary, so the router treats it as a prose question, down-weights
the code arm, and `creditCheck.ts` lands at #13 behind twelve prose documents.
That is the code-crowding protection working as designed; the fix was to pick a
question that genuinely spans, not to tune the ranker.

Two more that also span all three sources, held in reserve:

- `credit-unavailable reason code` — `PTR-388` first, `creditCheck.ts` second
- `who may approve a counterparty limit amendment` — `approvalQueue.ts` first,
  `ptrd-5` fourth

## Run order — 15 minutes, no Q&A inside it

| # | Time | On screen | The line |
|---|---|---|---|
| 1 | 0:00–1:30 | Same query scoped to Confluence, then unscoped | "Three pipes, three partial answers, and me stitching them together." |
| 2 | 1:30–4:30 | Ingest all three sources; run it again | "Second run is a diff, not a re-read." |
| 3 | 4:30–6:00 | Chunk/vector counts, the dot-product SQL | "No new infrastructure. Same schema on my laptop as on a cluster." |
| 4 | 6:00–9:00 | `eil search`, twice, identical | "No AI in this step. You can audit that. You can't audit a model's mood." |
| 5 | 9:00–11:30 | MCP two-phase in the audit log + context-cost comparison | "We never paid a model to read the documents it didn't need." |
| 6 | 11:30–13:00 | Same search without `grp-risk-ops` | "Not redacted. Not denied. Absent." |
| 7 | 13:00–15:00 | The `vw_*` views, then the empty `llm_calls` | "Forty searches. Nothing in the model-spend table." |

Step 1 is deliberately first: "we already have MCP servers" is the objection in
the room, and it is cheapest to answer before it is asked.

## What gets built

### 1. `demo/repo/` — synthetic service code

About ten TypeScript files mirroring the services the corpus already names.
Every file carries the same `SYNTHETIC DEMO CONTENT` banner as the pages.

```
demo/repo/
  ptc-gateway/src/orderPath.ts     synchronous control set
                  creditCheck.ts   ← rejects when psr-cache holds nothing
                  psrCache.ts      per-counterparty snapshot + publish timestamp
                  collar.ts
  psr-limits/src/exposure.ts       gross notional × tenor add-on band
                  bandTable.ts
                  publisher.ts
  credit-admin/src/amendment.ts    ← approver must differ from raiser
                  approval.ts
```

Indexed with `eil ingest repo . --subpath demo/repo --name ptr-services`, which
clones this checkout into `.eil-repos/` and indexes that subtree — no nested git
repo, nothing on the network. Routing through `source: "code"` means it gets the
overlapping line-window chunker, so the chunker claim is demonstrated where it is
true.

**Consequence:** cloning indexes committed state, so these files must be
committed before they are searchable. This is also why step 2 works — the commit
SHA is what the second run compares against to print `up to date`.

The code must be written so the three-source query actually resolves: the
reject-on-unavailable branch in `creditCheck.ts` needs the vocabulary that
`ptrd-4` and `PTR-388` use (`credit-unavailable`, presettlement, ptc-gateway).

### 2. `eil search --source <kind>`

A filter restricting results to one source. Needed for step 1's incomplete
answer. Threads through `searchDocs` as a predicate, not a post-filter, so the
ranking the audience sees is the ranking that source would have produced alone.

Narration caution: scoping EIL to Confluence is **not** the audience's Confluence
MCP server — theirs composes CQL, this ranks its own index. Say "here it is with
only Confluence in scope", not "this is your Confluence MCP".

### 3. `eil context-cost <query>`

Computes, from the real corpus:

- **pass-through**: total characters of the full body of every document the
  query matched — what a per-source server that returns page bodies would put
  in the model's context
- **two-phase**: characters of the phase-1 snippets, plus the full body of the
  single document `get_doc` was called on

Prints both, the ratio, and a rough token estimate. Both numbers are measured,
not estimated — that is the point.

### 4. `eil index:stats`

Prints chunk count, embedded-chunk count, vector dimension, and the actual SQL
expression used to score similarity. Step 3 needs something on screen; reading
the migration comment aloud is good but not sufficient.

### 5. `demo/eil.mjs`

The runner, in the same style as `demo/run.mjs`: prints each command before it
runs, so the audience sees the CLI rather than a wrapper.

### 6. `demo/eil-talking-points.md`

Narration for the seven steps, plus the honest caveats to volunteer, plus the
failure modes. Modelled on `demo/talking-points.md`.

## Honest caveats to volunteer

Carried forward from the existing demo where they still apply, plus new ones:

- The corpus is synthetic and banner-marked, including the code.
- The ACL is real and fail-closed, but fixture-fed; no connector stamps groups
  yet, so a live Confluence sync gives owner-level visibility only.
- Logs are proxied, not indexed (`fetch_logs`, `ts/tools.ts:147`) and need an
  ELK, so they are described rather than shown. This is a design decision — you
  do not index a high-volume, PII-dense, low-half-life firehose — not a gap.
- BM25 is schema and statistics only; ranking is still `ts_rank`.
- Code search is exact-equality and unranked.
- ~87% of chunks exceed the embedding model's window.
- No cost-in-dollars reporting.

## Testing

New CLI surface gets tests in `ts/tests/`, following the existing vitest setup:

- `--source` filter returns only that source, and returns nothing for an unknown
  source rather than silently returning everything
- `context-cost` numbers are derived from the corpus and the pass-through figure
  exceeds the two-phase figure
- `index:stats` reports a non-zero vector dimension when embeddings are present
  and degrades honestly when they are not

The demo runner is rehearsed from clean rather than unit-tested:

```sh
rm -rf .eil-demo .eil-repos
node demo/eil.mjs
```

---

## What changed during implementation

Everything above is as built except where noted here. Each of these was found by
running the demo rather than by reasoning about it.

**The demo question changed.** See above — the original one buried the code at
#13.

**`demo/repo/README.md` is not indexed.** It restates the demo's own question,
so it won the code arm and the top code result was a file describing the demo.
`--include '**/*.ts'` only.

**`ingest repo --acl-group` is new, and was not in this spec.**
`normalizeCode` hardcoded `aclGroups: []`, so every repo was owner-only. In the
governance step that meant switching principal made *all code* vanish as a side
effect, which misrepresents what the ACL is doing. Empty remains the default and
remains fail-closed.

**`EIL_PRINCIPAL` is new, and was not in this spec.** `localViewer()` read the
OS username with no override, and the presenter ingested the corpus and
therefore owns all of it — so no document could ever be shown being withheld.
It sits beside the `EIL_USER_GROUPS` override that was already there, at the
same trust level, local mode only. The boundary at
`viewerFromAuthenticatedClaims` is unmoved.

**The demo fixtures now carry `grp-engineering`.** Previously all but `ptrd-7`
had `acl_groups: []`, so a non-owner saw *nothing at all* — fail-closed, but it
reads as a broken setup rather than a working control. Now the contractor gets
six useful results with `ptrd-7` simply absent, which is the beat.

**The quarantined credential is an added beat.** `ptrd-6` already carried a
planted AWS key and database password. It costs twenty seconds and strengthens
the governance step, so the runner shows it.

**`context-cost` reports a per-match pair as well as a ratio.** The headline
ratio moves with the corpus — measured 1.5x at four matches, 4.9x at nineteen,
same query and index, because the one fetched document is a fixed cost that
amortises. The per-match figures do not move, so those are what generalise to
someone else's corpus.

**The chunks-over-window figure is ~40%, not the ~87% the older demo README
quotes.** That number was measured on a different corpus.

**`index:stats` carries a drift guard.** The scoring SQL it prints is asserted
by test to still appear in `ts/search.ts`.

### Known sharp edge, not fixed

Changing `--include`/`--exclude` on a repo has **no effect on an incremental
run**: `ingestRepo` short-circuits on the commit SHA before consulting the
filter, so the previous filter's documents stay indexed. Hit while building
this. The workaround is to clear the cursor or rebuild. Worth fixing separately;
it is not demo-specific.
