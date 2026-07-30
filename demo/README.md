# Demo — your org's data, nothing installed

Runs on **PGlite**: real Postgres compiled to WASM, loaded out of `node_modules`.
No Docker, no Postgres server, no admin rights. The embedding model is vendored
in the repo, so the vector arm needs no network either.

Every step below corresponds to a node in **[docs/system-map.html](../docs/system-map.html)** —
open it alongside and walk the diagram as you go.

```sh
node demo/run.mjs --repo /path/to/your/repo --space ENG --project PAY
```

---

## Setup (once)

```sh
export EIL_CONFLUENCE_URL=https://confluence.your.org   # base URL, no /wiki, no trailing path
export EIL_JIRA_URL=https://jira.your.org
eil auth login confluence      # PAT goes to the OS keychain, never to disk
eil auth login jira
```

Then, **before you are standing in front of anyone**:

```sh
eil demo:preflight --repo /path/to/your/repo
```

It checks the backend, the model, both connectors, and the repo — and prints the
fix for anything wrong. It is read-only, so run it as often as you like. Two
things it catches that otherwise surface as raw git or HTTP errors mid-demo:

- a **stale `.eil-repos/`** — `git clone` into a non-empty directory just fails
- your repo's **actual branch**; the default is `main` and plenty of repos are `master`

## Scoping — read this before pointing it at a real instance

`--space` and `--project` are **required** for the live sources. An unscoped
Confluence sync pulls the entire instance, which is a poor first impression and
an unkind thing to do to your org's API from a laptop. Start with one space and
one project.

Connectors run on **your** personal token: you can only index what you could
already read.

---

# The narration — seven beats

`node demo/run.mjs` walks all of these in order. Drive them by hand if you want
to control the pace; the commands below are exactly what the runner runs.

Rehearse the whole thing from clean first — it takes a couple of minutes:

```sh
rm -rf .eil-demo .eil-repos
export EIL_DATABASE_URL=pglite://.eil-demo
node demo/run.mjs
```

### Beat 1 — there is no server

```sh
pnpm eil db migrate
```

**Say:** nineteen migrations into a Postgres that is running inside this Node
process. Nothing was installed, no Docker, no admin rights, and this same schema
runs unchanged against a real cluster.

### Beat 2 — your data, on your credentials

```sh
pnpm eil ingest confluence --space ENG
pnpm eil ingest jira --project PAY
pnpm eil ingest repo /path/to/repo --branch main --name repo --include '**/*.*'
```

Plus the fixture corpus the requirements artefact cites, which the runner ingests
for you:

```sh
for f in demo/fixtures/*.json; do
  case "$f" in *ptrd-*) pnpm eil ingest confluence --fixture "$f";; *) pnpm eil ingest jira --fixture "$f";; esac
done
pnpm eil stats:refresh
```

**Say:** the connector uses *your* personal token, so it can only index what you
could already read. Sync is incremental from a stored cursor and hash-gated —
re-running costs nothing. Commit dates become recency; issue links, labels and
imports become graph edges.

### Beat 3 — retrieval, with no LLM in the loop

```sh
pnpm eil search "how do we handle a limit reduction"
```

**Say:** four lexical arms — strict and loose full-text over prose, strict and
loose over the code index — plus a vector arm when the local model is available,
all fused by reciprocal rank. Point at `arms_contributing` and `top_score` in the
JSON; `arms_contributing` counts the arms that actually returned something, so
expect 3 to 5. Same query, same corpus, same order, every time. Nothing here
spends a token.

If the embedding model is present, this is the one to slow down on:

```sh
pnpm eil ivf build
```

It prints two sweeps and then a decision. The first is measured with **every**
cluster probed, so the only loss is what quantization discarded; the second then
varies clusters at that oversample. The two error sources are separated, not
confounded. On a small corpus it often ends with *"No PARTIAL probe reached
recall@10 >= 0.98, so IVF is not adopted"* — **that is the demo working.** The
gate refused an optimisation that would have cost recall, and said so.

### Beat 4 — the credential that cannot be retrieved

```sh
pnpm eil quarantine list
pnpm eil search "deploying the payment service"
```

**Say:** `demo/secret-page.json` contains an AWS key and a database password. It
was never chunked, so the credential is absent from the tsvector, the embeddings,
`ts_headline` and every snippet — the search returns nothing. Then show the other
half, which is the interesting one: on a real codebase the scanner also flags
test fixtures and docs that legitimately contain key-shaped strings.

```sh
pnpm eil quarantine clear <id>     # accept a false positive; it is re-chunked
```

Acceptance is keyed on the **value**, not the file, so if that file later gains a
*different* credential it is quarantined again. Accepting one finding cannot
silently accept the next.

### Beat 5 — the gate

```sh
pnpm eil reqs check demo/PTR-401.reqs.json
```

**Say:** this is a requirements artefact an agent produced. Forty-six checks.
Every derived field — the magnitude bands, the leaf flags, the traceability index
— is recomputed from the body and compared, and every cited quote is re-read out
of the catalog through the same audited tool path an agent would use. It says
`46 checks run   0 errors   PASSED`.

### Beat 6 — tamper with it

**This is the beat.** Everything before it is setup.

```sh
node demo/tamper.mjs
```

Six copies of that artefact, one single-field edit each, the real CLI run over
each one. Six refusals, and each names the check that caught it:

| # | The edit | Refused by |
|---|----------|-----------|
| 1 | a stored score changed from 2 to 21 | `SCORE-001` |
| 2 | `" Effective timing TBD."` appended to the top-level requirement | `DEFER-001` |
| 3 | a recorded question deleted, its "we asked" record left behind | `CLARIFY-001` |
| 4 | one word changed inside a quoted citation | `CLARIFY-005` |
| 5 | the first approver changed from human to agent | `GATE-006` |
| 6 | the traceability index emptied | `META-002`, `TRACE-001` |

Run one on its own if someone asks:

```sh
node demo/tamper.mjs --tamper 4
```

**Say:** number 4 is the one that leaves the artefact. The gate re-fetches the
cited page and greps for the quote character for character. A fabricated citation
is not merely implausible here — it is mechanically detectable. And number 5 is
the line the whole phase exists to draw: an agent may draft, score, ground and
analyse a requirement set. It may never approve one.

The script asserts **46 checks ran** on every single invocation. `CLARIFY-005`
does not fail when the catalog is unreachable — it *disappears*, and the count
drops to 45. Without that assertion, beat 6 would look identical while proving
nothing.

### Beat 7 — all of it is a row

```sh
pnpm eil audit
pnpm eil reqs render demo/PTR-401.reqs.json --out demo/PTR-401.html
pnpm eil report --out demo/metrics.html
pnpm eil eval:mine
```

**Say:** `"ok": true` is the assertion, not the summary. Every tool call the demo
made landed as an audited row with a trace id; `eval:mine` promotes those real
queries into a labelled set, which is the answer to *"how do you know retrieval
got better?"* — and to why hand-maintained golden-query files stay empty. Open
the rendered artefact and show that a refused one is stamped **REFUSED** rather
than projected as a clean document.

Then point an agent at the whole thing:

```sh
claude mcp add eil -- pnpm -s --dir "$PWD" eil serve
```

---

## The walk, against the system map

| # | Step | The map node it demonstrates |
|---|---|---|
| 1 | `db migrate` | *Zero-install backend* — 19 migrations, no server |
| 2 | `ingest confluence --space` | *Only the spaces you name* |
| 3 | `ingest jira --project` | *Projects scoped by* — issue links and labels become edges |
| 4 | `ingest repo` | *Clone, walk* — commit dates become recency |
| 5 | `ingest --fixture demo/fixtures/*` | The PTR-DEMO corpus the gate re-reads citations from |
| 6 | `embed backfill` | *Meaning, embedded* — local ONNX, no per-query cost |
| 7 | `ivf build` | The system **measuring its own recall** and choosing a parameter |
| 8 | `search` | *Four lexical arms* (strict and loose, prose and code) plus a vector arm when the local model is available, fused by rank, plus tier and freshness |
| 9 | `search retryHandler` | *Exact terms, identifiers* — the code index, not the prose arm |
| 10 | quarantine | *Visibility lives on the document* |
| 11 | `reqs check` | The gate — generated fields recomputed, citations re-read |
| 12 | `demo/tamper.mjs` | Six edits, six refusals, each naming itself |
| 13 | `audit` | *Every tool call lands as a row* |
| 14 | `eval:mine` | *Recall trend decides what gets built next* — the loop back over the top |
| 15 | `serve` over MCP | *Connected over MCP* — an agent pulls ranked, ACL-filtered context |

---

## Honest caveats — volunteer these

Say these before someone asks. Every one of them is a thing a sharp person in
the room will find in ten minutes, and volunteering it is what makes the rest
of the demo credible.

**The PTR-DEMO corpus is synthetic.** Every Confluence page and Jira ticket the
gate re-reads citations from was written for this demonstration — the pre-trade
risk platform, the limit-reduction argument, the contradictory gateway notes.
Each page carries a `SYNTHETIC DEMO CONTENT` banner in its own body saying so:
illustrative only, not a production reference, not to be cited in design or
change documentation. It exists so the demo runs identically offline and against
a real Atlassian estate — the pipeline does not know the difference, because
ingestion normalises both into the same canonical document. Say this while the
gate is on screen re-reading those citations; it is the first thing a sharp
person in the room will wonder about the plausible-looking pages.

**The ACL is owner-only against live data.** Visibility is stamped on the
document and reads fail closed — but every connector currently stamps
`acl_groups: []`, and `ingested_by` is the OS user. Multi-group visibility works
only in **fixture mode**, because a fixture can carry the field and a live sync
does not yet populate it. On a shared server every document would be owned by
the service account. It is fail-closed and correct; it is also delivering less
than "fail-closed ACL" implies. Do not claim multi-user visibility.

**This is phase 1 of 4.** What you just watched is elaboration and gating —
turning a work item into a scored, grounded, refusable requirements artefact.
Design, decomposition into tasks, and implementation are phases 2, 3 and 4. The
schema carries `updatedAt` as a staleness pin precisely so a later phase can
detect that it is working from a body that has moved.

**BM25 is schema and statistics only.** Migration 0017 adds the tables and
`stats:refresh` computes document frequency, N and avgdl — but the ranking in the
retrieval path is still `ts_rank`. Nothing is scored by BM25 yet. The groundwork
is real; the ranking change is not done.

**Code search is exact-equality and unranked.** `search_code` matches
`ci.value = $4` and orders by path and line number. It is an index lookup, not a
ranked search: excellent for "where is this identifier", useless for "find me
code that does roughly this". Zoekt-style ranking and symbol routes are future
work; the router today only steers arm weights.

**~87% of chunks exceed the embedding model's window.** `eil audit` reports
`chunks_over_embed_window`. MiniLM stops at ~1024 characters and chunks are 3200,
so the vector arm reads roughly the first third of most chunks. Retrieval still
works; the ceiling is real, and the fix — matching chunk size to the model, or a
longer-context model — is gated on the eval set existing.

**There is no cost-in-dollars reporting.** The `llm_calls` table has existed
since migration 0002 but has only just gained its first writer, and the provider
this pipeline actually runs on (`CliProvider`, wrapping headless Amp and Copilot)
reports no token counts at all. So you get call counts and latency, not spend. If
someone asks "what did that cost?", the honest answer is that the row is there
and the number is not.

**No Grafana.** It is provisioned in the repo but it needs Docker and a real
Postgres backend, and this demo has neither. `eil report --out demo/metrics.html`
produces a self-contained HTML report over the same fact tables.

---

## If it breaks, say this

Rehearse this section too. Every one of these has happened.

**The corporate proxy blocks the live ingest.**
Fall back to the fixture corpus and drop the live beat:

```sh
node demo/run.mjs                 # no --space, no --project: fixtures only
```

Say: "the connector is HTTP against your instance and this network will not let
me out — here is the same pipeline on a fixture corpus." **Nothing else in the
demo changes.** Beats 3 through 7 are identical, because ingestion normalises
into one canonical document either way. Do not spend stage time debugging the
proxy.

**The embedding model is unavailable.**
`@huggingface/transformers` is an optional dependency and may simply not be
there. Both embedding steps are optional in the runner and it prints
`embeddings unavailable — running lexical arms only`. Say exactly that. The four
lexical arms are complete without it and beats 4 through 7 are unaffected.

**Never** set `EIL_EMBED_PROVIDER=fake` to make the vector arm appear. It emits
deterministic pseudo-random vectors; the results would be noise dressed as
meaning. And with the model absent, do not call what you are showing *semantic*
search — it is lexical search, and it is good.

**The analyser refuses something mid-demo.**
Read the check id out loud and explain what it caught. **That is the product
working.** A gate that only ever passes is not a gate. The refusal names itself,
states the observed value and the expected one, and points at the exact path in
the artefact — which is the whole argument for building it this way.

The one refusal that is genuinely an accident is `CLARIFY-005` on the *clean*
artefact: it means the artefact's citations and the ingested corpus have drifted
apart. `demo/tamper.mjs` checks the clean baseline first and stops with that
explanation rather than running six confusing tampers on top of it. Fix it by
re-ingesting the corpus:

```sh
for f in demo/fixtures/*.json; do
  case "$f" in *ptrd-*) pnpm eil ingest confluence --fixture "$f";; *) pnpm eil ingest jira --fixture "$f";; esac
done
```

**`demo/tamper.mjs` says only 45 of 46 checks ran.**
The catalog is not reachable, so the one check that leaves the artefact was
skipped. Check `EIL_DATABASE_URL`, then `pnpm eil db migrate`, then re-ingest as
above. The script refuses to run the drill in this state on purpose — a tamper
that silently does not run is worse than one that fails.

**Someone asks for Grafana.**
It is not shown: it needs Docker and a Postgres backend. Run
`pnpm eil report --out demo/metrics.html` and open that instead — same fact
tables, same numbers, no infrastructure.

---

## Reset

```sh
rm -rf .eil-demo .eil-repos demo/metrics.html demo/judgments.md
```

Everything lived in `.eil-demo/`. Nothing was installed, and nothing outside the
repo was touched.
