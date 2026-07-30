# The knowledge plane — 15 minutes

For a room that already runs MCP servers against Confluence, Jira and Bitbucket.
Not a script to read. The lines are here so you have something to fall back on
if you lose the thread.

**This is not the requirements-gate talk.** That one is `demo/talking-points.md`
and it makes a different argument. This one is about the layer underneath.

| | Step | Time |
|---|---|---|
| 1 | The question no single pipe answers | 0:00 – 1:30 |
| 2 | Loading it, and loading it again | 1:30 – 4:30 |
| 3 | Where it lives | 4:30 – 6:00 |
| 4 | Search it, with no AI in the loop | 6:00 – 9:00 |
| 5 | Let an AI use it, and count the cost | 9:00 – 11:30 |
| 6 | Ask as someone who isn't allowed | 11:30 – 13:00 |
| 7 | All of it is a row | 13:00 – 15:00 |

---

## Before the room comes in

Build the index first. It takes a couple of minutes and none of it is
interesting to watch:

```sh
export EIL_DATABASE_URL=pglite://.eil-demo
node demo/eil.mjs                 # runs the whole thing, start to finish
```

Then rewind to the terminal and start the talk at the search steps. Or run it
with `--pause` and drive it yourself.

Check this prints results from **three** sources before you stand up:

```sh
pnpm eil search "how stale can the presettlement view be before an order is rejected" --limit 6
```

If `executor` says only `fts_prose` you have no code indexed — re-run the
ingest. If it has no `vec` the embedding model is unavailable; that is fine,
say "text search only", and do **not** call it semantic search.

---

## The one sentence

> You already have a pipe to each system. This is the index across them.

Say it early and say it again at the end. Everything in the fifteen minutes is
evidence for that sentence.

**Do not say "it sits above your MCP servers."** It doesn't. It has its own
connectors and never calls another MCP server. An engineer who reads
`ts/ingest/` afterwards will find that out, and then nothing else you said
counts. It sits *beside* them and replaces the per-source pattern for retrieval.

---

## 1 — The question no single pipe answers

> How stale can our view of a counterparty's credit be before we reject the
> order?

Ask it of Confluence alone:

```sh
pnpm eil search "how stale can the presettlement view be before an order is rejected" --source confluence --limit 3
```

> That's the market access controls page. It says a control that cannot be
> evaluated has not passed, so the order is rejected. That's the rule, and it's
> correct, and it is not an answer. It doesn't tell me the number and it doesn't
> tell me whether anything actually enforces it.

Then Jira alone:

```sh
pnpm eil search "how stale can the presettlement view be before an order is rejected" --source jira --limit 3
```

> There's the ticket where somebody agreed one second. Also true, also partial.

Then all of it:

```sh
pnpm eil search "how stale can the presettlement view be before an order is rejected" --limit 6
```

> And there it is. The rule from the wiki. The number from the ticket. And the
> line of code that enforces it, at the top.
>
> Three pipes gave me three partial answers and left me to stitch them
> together. That's the problem this solves.

**If someone says "our Confluence MCP would find that page too" — they're
right, and say so.** The point isn't that any one of them is bad. It's that the
answer was never in any one of them.

---

## 2 — Loading it, and loading it again

Show the ingest, then the second run:

```
1 seen, 0 changed
code:ptr-services:demo/repo: up to date (e8be527…)
```

> Second run is a diff, not a re-read. Prose is gated on a content hash. The
> repo doesn't even list the files — it compares the commit SHA and stops.
>
> That's what makes it affordable to keep current. Re-indexing isn't an event
> you schedule for the weekend, it's something that costs nothing when nothing
> changed.

For the engineers, one line worth adding:

> The hash covers the title, the URL, the hierarchy **and the ACL groups** — not
> just the body. A permissions change that a body-only hash ignored would leave
> a revoked group in the index indefinitely.

And on the chunker:

> Different shapes get different chunkers, and both are deterministic. Prose is
> split on its headings. Code gets fixed line windows — sixty lines, ten of
> overlap — so a function that straddles a boundary is still found, and the
> chunk still cites a line range.

---

## 3 — Where it lives

```sh
pnpm eil index:stats
```

> One Postgres. The extension list is read out of `pg_extension` and it's
> empty.
>
> The vectors are stored unit length, which makes cosine similarity a plain dot
> product — and a dot product is a sum over two arrays, which core Postgres can
> do. There's no pgvector here, and there's nothing to install. This is running
> in WASM inside a Node process on my laptop, and the identical schema runs on a
> real cluster.

Volunteer the ceiling on the same breath — it's on screen anyway:

> Read the percentage off the screen — on this corpus it's around 40%. Those
> chunks are longer than the embedding model's window, so the vector arm only
> reads their opening. That's real, we know about it, and the fix is gated on
> having an evaluation set to prove it helped.

---

## 4 — Search it, with no AI in the loop

Point at `executor` in the JSON.

> Four keyword arms — strict and loose, over prose and over code — plus a
> meaning-based arm, and they're merged by rank position rather than by score.
> Nothing to normalise, nothing to tune.
>
> Prose and code are separate arms on purpose. Because the merge is rank-based,
> a code file with an inflated score can only ever outrank *other code*. It can
> never push the wiki page out of the results.

Then run the identical query again:

> Same query, same corpus, same order. Every time.
>
> There's no model anywhere in that. Retrieval is a database query, not a
> completion. You can audit it, you can regression-test it, and it can't have a
> bad day.

---

## 5 — Let an AI use it, and count the cost

```sh
pnpm eil context-cost "how stale can the presettlement view be before an order is rejected"
```

> Phase one, the agent asks for a list and gets back IDs and one-line previews.
> Phase two, it opens the one document it actually wants.
>
> Against a connector that answers a search by handing over the pages: read the
> per-match pair off the screen. It's roughly ten to one.

**Read both numbers off the terminal rather than memorising them** — they move
with the corpus, and being caught quoting a figure the screen contradicts costs
more than the figure was worth.

**Quote the per-match pair, not the headline ratio.** The ratio climbs as more
documents match — measured on this corpus it went from 1.5x at four matches to
4.9x at nineteen, same query, same index — because the one document the agent
opens is a fixed cost that amortises. The per-match pair doesn't move, which is
what makes it safe to say about *their* Confluence, where pages are much larger
than these.

> On your estate that gap is wider, because your pages are bigger than mine.

Then the honest boundary, before anyone finds it:

> This only wins because the agent is selective. If it opened every match the
> saving would be gone, and the tool measures that too rather than hiding it.

---

## 6 — Ask as someone who isn't allowed

The best 90 seconds in the demo. Slow down.

```sh
EIL_PRINCIPAL=a.contractor EIL_USER_GROUPS=grp-engineering \
  pnpm eil search "what is CPTY-ALPHA presettlement limit" --limit 6
```

> This is a contractor asking for a counterparty's credit line. Six results.
> Useful ones. No error, no "access denied", no greyed-out row.
>
> The page with the actual numbers on it is just not there. And from where they
> are sitting, there is nothing to notice — the list is full, the search worked,
> and they have no way to tell that anything was withheld.

Then add the group:

```sh
EIL_PRINCIPAL=r.duval EIL_USER_GROUPS=grp-engineering,grp-risk-ops \
  pnpm eil search "what is CPTY-ALPHA presettlement limit" --limit 6
```

> Same query, same index, one group added. Now it's the top result, with a
> 250 million dollar line on it.
>
> Visibility is stamped on the document, not decided by the query. An unstamped
> document is readable by whoever ingested it and nobody else. So the failure
> direction is fixed: a bug in the application can only ever show you *less*.

Then the credential:

```sh
pnpm eil quarantine list
pnpm eil search "AKIA aws access key deployment credentials" --limit 4
```

> One page in here has an AWS key and a database password on it. It was never
> chunked, so the key isn't in the text index, isn't in the embeddings and isn't
> in any snippet. There's nothing to redact on the way out because it never went
> in.

Say the harder half yourself:

> On a real codebase this also flags test fixtures and docs that legitimately
> contain key-shaped strings, and you clear those. Clearing is keyed on the
> value, not the file — so if that file later gains a *different* credential,
> it's caught again. Accepting one finding can't silently accept the next.

---

## 7 — All of it is a row

```sh
pnpm eil report --out demo/eil-metrics.html
```

> Every search and every fetch you just watched is a row: who asked, what
> matched, how long it took.
>
> These aren't dashboard queries. The `vw_` views in the migrations *are* the
> metric definitions — they're in version control, they're code-reviewed, and
> they're tested.

For the engineers, name three:

> `vw_zero_results` is the one I'd watch. It's the questions the org asked that
> we couldn't answer, and it's the only honest input to what gets indexed next.
> `vw_two_phase` is fetches per search — near one means agents are being
> selective the way the contract intends. `vw_eval_trend` is whether retrieval
> is getting better or worse.

Then the close:

```sh
pnpm eil audit
```

Open the model-spend table. It's empty.

> Forty-odd searches in the last fifteen minutes. The table that records what we
> spent on models has nothing in it.
>
> That's not missing instrumentation. That's the architecture. The retrieval is
> a database query, so there was never a model call to bill.

---

## Volunteer these before anyone finds them

Say them yourself. It buys more than it costs.

- **The corpus is synthetic**, wiki pages, tickets and code alike. Every one
  carries a banner saying so. I wrote them to interlock.
- **The permissions are real and fail-closed, but they're fed from the fixture.**
  No connector stamps groups yet, so a live Confluence sync today would give you
  owner-level visibility only. The gap is in the connector, not in the
  enforcement — what you watched is the real code path in `ts/search.ts`.
- **Logs are proxied, not indexed.** `fetch_logs` queries the logging system
  live, recency-sorted and capped. That's deliberate — you don't index a
  high-volume, PII-dense firehose — but it means logs need credentials and
  aren't in this run.
- **No cost in pounds.** Call counts and latency, yes. Tokens and money, no —
  the CLIs report neither.
- **BM25 is schema and statistics only.** The tables exist and the numbers are
  computed; the ranking still uses `ts_rank`. Groundwork real, ranking change not
  done.
- **Code search is exact-match and unranked.** Excellent for "where is this
  identifier", useless for "find code that does roughly this."

---

## If it breaks

- **"Show me it against our real Confluence, now."** Don't. Say the connectors
  are real and scoped — `eil ingest confluence --space ENG`, on your own token,
  so you can only index what you could already read — and offer to show them
  afterwards. There is no network in this run and that is the point.
- **Embeddings unavailable.** Say "running on text search only." The four
  keyword arms are complete without it. Never set `EIL_EMBED_PROVIDER=fake` —
  it emits pseudo-random vectors, and the results would be noise dressed as
  meaning.
- **A search returns nothing.** Check `EIL_DATABASE_URL` is set in *that*
  terminal. It is the one setup mistake that makes everything look broken.
- **Someone asks for Grafana.** Not showing it — it needs Docker and a real
  Postgres. `eil report` covers the same fact tables with no infrastructure.

---

## The three lines to get right

1. *"Three pipes gave me three partial answers and left me to stitch them together."*
2. *"There is nothing in the response to notice."*
3. *"The model-spend table is empty. That's not missing instrumentation, that's the architecture."*
