# The knowledge plane — reference

The operational companion to **[eil-talking-points.md](eil-talking-points.md)**,
which is the thing you actually present from. This is what you read the night
before, and what a colleague reads to run it without you.

> **This is not the requirements-gate demo.** That one is `demo/run.mjs`,
> documented in [README.md](README.md), and it argues something else. Running
> the wrong one in front of the wrong room is the most expensive mistake
> available here.

For a one-page picture to put on a second screen — the five steps, the cost
mechanic, and what else could be built on the same substrate — open
[docs/eil-platform.html](../docs/eil-platform.html). The full wiring diagram is
[docs/system-map.html](../docs/system-map.html).

```sh
node demo/eil.mjs
```

That is the whole invocation. Eighteen steps, about two minutes. No Docker, no
Postgres server, no admin rights, no VPN, no credentials, and nothing on the
network — the backend is PGlite, which is real Postgres compiled to WASM and
loaded out of `node_modules`, and the embedding model is vendored in the repo.

| Flag | |
|---|---|
| `--pause` | wait for Enter between steps, so you control the pace |
| `--keep` | do not wipe the data directory first — resume a part-built run |
| `--skip-embed` | skip the local model; search runs lexical-only (17 steps) |
| `--data <dir>` | PGlite directory (default `.eil-demo`) |

---

## Who this is for

A room that **already runs MCP servers** against Confluence, Jira and Bitbucket.
That changes the argument completely: they do not need convincing that an agent
should be able to read the wiki. They need an answer to *"we already have this."*

The answer, in one sentence:

> You already have a pipe to each system. This is the index across them.

**Never describe it as sitting above their MCP servers.** It has its own
connectors — Confluence REST/CQL, Jira JQL, `git clone`/Bitbucket API, ELK — and
never calls another MCP server. An engineer who reads `ts/ingest/` afterwards
will discover that, and then nothing else you said counts.

---

## Before you are standing in front of anyone

Build the index first. It takes a couple of minutes and none of it is worth
watching:

```sh
node demo/eil.mjs
```

Then rewind the terminal and open the talk at **step 8**, where the narration
starts. Steps 1–7 are the stage being set.

Then check the one thing that decides whether the demo works:

```sh
export EIL_DATABASE_URL=pglite://.eil-demo
pnpm eil search "how stale can the presettlement view be before an order is rejected" --limit 6
```

You want **three sources** in the top six, with `creditCheck.ts` at or near the
top. Read `executor` in the JSON:

| `executor` says | Meaning |
|---|---|
| contains `fts_code` | code is indexed — good |
| only `fts_prose*` | **no code indexed.** Re-run the repo ingest |
| contains `vec` | the vector arm is live |
| no `vec` | model unavailable. Say "text search only". Do **not** call it semantic search |

---

## The question the demo is built around

> How stale can the presettlement view be before an order is rejected?

It is chosen, not arbitrary. Its answer does not exist in any one system:

| Source | Contribution |
|---|---|
| Confluence `ptrd-4` — Market Access Controls | The rule: a control that cannot be evaluated has not passed, so the order is rejected |
| Jira `PTR-415` | The number everyone agreed on — 1s |
| `demo/repo/ptc-gateway/src/creditCheck.ts` | `MAX_VIEW_AGE_MS`, the line that enforces it |

Two more that also span all three sources, if someone asks for another:

```sh
pnpm eil search "credit-unavailable reason code" --limit 6
pnpm eil search "who may approve a counterparty limit amendment" --limit 6
```

**A question that does not work, and why it is interesting.** *"Why does
ptc-gateway reject an order when the credit check cannot be evaluated"* is
phrased in the wiki's own vocabulary, so the router classifies it as prose,
down-weights the code arm, and `creditCheck.ts` lands at **#13** behind twelve
prose documents. That is the code-crowding protection in `ts/search.ts:279`
working exactly as designed — a code chunk with an inflated `ts_rank` can only
outrank other code, never evict prose. Worth knowing, and worth saying if the
ranking surprises you live.

---

## The eighteen steps

| # | Step | What it demonstrates |
|---|---|---|
| 1 | `db migrate` | Nineteen migrations into a Postgres inside this Node process. Same schema on a real cluster |
| 2 | `ingest confluence/jira --fixture` ×13 | A fixture and a live sync normalise to the same canonical document |
| 3 | `ingest repo --subpath demo/repo` | Clone, walk, filter. Code takes the overlapping line-window chunker |
| 4 | `stats:refresh` | Document frequency, N, average length — ranking groundwork |
| 5 | `embed backfill` | Local ONNX model. No network, no per-query cost. Optional |
| 6 | re-ingest everything | **The point of the step:** prose says `0 changed`, the repo says `up to date (<sha>)` before listing a file |
| 7 | `index:stats` | `float4[]`, unit-normalized, dot product in SQL, empty extension list |
| 8 | `search --source confluence` | The rule, and nothing else. Correct and not an answer |
| 9 | `search --source jira` | The agreed number. True and partial |
| 10 | `search` | All three sources. Point at `executor` |
| 11 | `search` again | Byte-identical. No model in the retrieval path |
| 12 | `context-cost` | Measured, not asserted. Quote the per-match pair |
| 13 | `search` as `a.contractor` | Six useful results, restricted page **absent** |
| 14 | `search` as `r.duval` | One group added, page at #1 with the credit lines |
| 15 | `quarantine list` | A page with an AWS key was never chunked |
| 16 | `search` for the key | Not retrievable. The string is nowhere in the response |
| 17 | `report --out` | The `vw_*` views over the fact tables |
| 18 | `audit` | `"ok": true` is an assertion, not a summary |

### Driving it by hand

Every step is a plain CLI call. `EIL_DATABASE_URL` must be set in whatever
terminal you type into — the runner sets it itself, a hand-typed command does
not, and that is the single setup mistake that makes everything look broken.

```sh
export EIL_DATABASE_URL=pglite://.eil-demo

pnpm eil index:stats
pnpm eil search "how stale can the presettlement view be before an order is rejected" --source confluence --limit 3
pnpm eil search "how stale can the presettlement view be before an order is rejected" --limit 6
pnpm eil context-cost "how stale can the presettlement view be before an order is rejected"

EIL_PRINCIPAL=a.contractor EIL_USER_GROUPS=grp-engineering \
  pnpm eil search "what is CPTY-ALPHA presettlement limit" --limit 6
EIL_PRINCIPAL=r.duval EIL_USER_GROUPS=grp-engineering,grp-risk-ops \
  pnpm eil search "what is CPTY-ALPHA presettlement limit" --limit 6
```

---

## The numbers, and why not to memorise them

They move with the corpus. Read them off the screen.

**`context-cost` reports two things and only one of them travels.** The headline
ratio climbs as more documents match — measured on this corpus it went 1.5x at
four matches to 4.9x at nineteen, same query, same index — because the single
document the agent opens is a fixed cost that amortises. The **per-match pair**
does not move: roughly 2,700 characters sent in full against roughly 270 as a
snippet. That is the figure that is safe to say about someone else's Confluence,
where pages are considerably larger than these.

Say the boundary yourself: two-phase only wins because the agent is selective.
`--fetch 99` collapses the saving, and the tool measures that rather than hiding
it.

---

## Honest caveats — volunteer these

Every one of these is findable in ten minutes by a sharp person in the room, and
volunteering them is what makes the rest credible.

**The corpus is synthetic** — wiki pages, tickets and code alike. Each carries a
`SYNTHETIC DEMO CONTENT` banner in its own body. The Confluence pages and Jira
tickets also exist in a real instance so the room can look at them, but the demo
never fetches them: it reads its own indexed copy, ingested from the fixture.

**The ACL is real and fail-closed, and it is fixture-fed.** Visibility is
stamped on the document, every read fails closed, and what you watched is the
real enforcement path in `ts/search.ts` — not a demo shim. The gap is upstream:
**no connector stamps groups yet**, so a live Confluence sync gives owner-level
visibility only. That is a gap in the connectors, not in the enforcement. Do not
claim live multi-user visibility.

**`EIL_PRINCIPAL` is a local-mode convenience, not an authentication story.** It
sits beside the `EIL_USER_GROUPS` override that was already there. In local mode
the caller owns the process and the DSN, so identity is an assertion. A shared
HTTP deployment must build its viewer with `viewerFromAuthenticatedClaims()`
after verifying a token, and never reaches `localViewer()`.

**Logs are proxied, not indexed.** `fetch_logs` (`ts/tools.ts:154`) queries the
logging system live, recency-sorted and hard-capped, and its description says so.
That is deliberate — you do not index a high-volume, PII-dense, low-half-life
firehose — but it needs `EIL_ELK_URL`/`EIL_ELK_TOKEN`, so logs are described in
this demo rather than shown.

**BM25 is schema and statistics only.** Migration 0017 adds the tables and
`stats:refresh` computes the numbers, but ranking is still `ts_rank`. Groundwork
real, ranking change not done.

**Code search is exact-equality and unranked.** `search_code` matches
`ci.value = $4` (`ts/code-search.ts:50`) and orders by path and line. Excellent for "where is this
identifier", useless for "find code that does roughly this."

**~40% of chunks exceed the embedding model's window.** `index:stats` prints the
figure. MiniLM stops around 1,024 characters; the vector arm reads only the
opening of those chunks. Lexical retrieval is unaffected.

**There is no cost in pounds.** `llm_calls` exists and `vw_cost_per_run` reads
it, but an EIL-only run makes no model calls at all — so the table is empty, and
that is the argument rather than a defect. Do **not** show `vw_spend_daily`: it
reads `metrics.usage_facts`, which has no writer outside a test.

**No Grafana.** It is provisioned in the repo but needs Docker and a real
Postgres backend. `eil report --out demo/eil-metrics.html` covers the same fact
tables with no infrastructure.

---

## If it breaks

**A search returns nothing, or the gate looks broken.**
`EIL_DATABASE_URL` is not set in that terminal. This is the one that will
happen. `export EIL_DATABASE_URL=pglite://.eil-demo` and run it again.

**`executor` shows no `fts_code`.**
No code is indexed. Re-run step 3:

```sh
pnpm eil ingest repo . --subpath demo/repo --name ptr-services \
  --include '**/*.ts' --acl-group grp-engineering
```

If it says `up to date (<sha>)` and you still have no code, the cursor is ahead
of the index — see the sharp edge below. `rm -rf .eil-demo .eil-repos` and
rebuild.

**Embeddings unavailable.**
`@huggingface/transformers` is an optional dependency and may simply not be
installed. The step is optional and the run continues. Say "running on text
search only" — the four lexical arms are complete without it, and steps 8
through 18 are unaffected.

**Never** set `EIL_EMBED_PROVIDER=fake` to make the vector arm appear. It emits
deterministic pseudo-random vectors; the results would be noise dressed as
meaning. And with the model absent, do not call what you are showing *semantic*
search — it is lexical search, and it is good.

**Someone asks to see it against the real Confluence, live, now.**
Don't. The run is scoped to fixtures deliberately: it removes the proxy, the VPN
and the credentials from the risk list. Say the connectors are real and scoped —
`eil ingest confluence --space ENG`, on your own personal token, so you can only
index what you could already read — and offer to show them afterwards. Then open
the page in the browser, which is what they actually want to look at. Do not
spend stage time on a network.

**Someone asks for Grafana.**
Not showing it. `pnpm eil report --out demo/eil-metrics.html` instead.

**The contractor in step 13 sees nothing at all.**
The fixtures have lost their `grp-engineering` stamp. Fail-closed is working,
but zero results reads as a broken setup rather than a working control. Check
`demo/fixtures/*.json` carry `acl_groups`, and that step 3 was run with
`--acl-group grp-engineering`.

---

## Known sharp edge

**Changing `--include`/`--exclude` has no effect on an incremental repo run.**
`ingestRepo` short-circuits on the commit SHA (`ts/ingest/pipeline.ts:204`)
before the filter is consulted, so the previous filter's documents stay indexed
and the run prints a confident `up to date`. Clear the data directory and
rebuild. This is a real bug, it is not demo-specific, and it is not fixed.

---

## Reset

```sh
rm -rf .eil-demo .eil-repos demo/eil-metrics.html
```

Everything lives in `.eil-demo/`. Nothing is installed and nothing outside this
repo is touched.

## Handing it to an agent

```sh
claude mcp add eil -- pnpm -s --dir "$PWD" eil serve
```

Six tools, and only one of them writes: `refresh_doc`, and only for a document
you can already read.
