# Gated requirements elaboration, and the demo that proves it

Status: **design, approved for implementation** · 2026-07-30

## 1. What this is for

A 30-minute presentation tomorrow (2026-07-31) to internal engineering leadership
and executives. Two outcomes wanted: **positioning** (own this problem) and
**adoption as the standard** (agentic delivery work goes through this layer).

The subject domain is the firm's own: **pre-trade checks and the pre-settlement
risk (PSR) credit service** in financial markets. The feature elaborated is
*intraday PSR limit amendment*.

Two source documents shape the design and are treated as specifications to
implement, not as third-party products:

- `Agentic-SDLC-Framework-Technical-Specification.pdf` — a four-phase gated
  pipeline (Define → Design → Plan → Implement) over typed JSON artefacts.
- `pdlc-chain.pdf` — the same chain as five commands, `feature.md → reqs.json →
  design.json → stages.json → code + stage_journal.json → Confluence page`.

Neither has an implementation on any machine available to us. This design builds
**phase 1 of 4 only** — Define — and integrates it with EIL, which already
exists and is the harder half.

## 2. The thesis

Two planes, and the value is in the seam between them.

```
   DELIVERY PLANE     artefacts that cannot lie
                      AI proposes -> deterministic code decides -> a named human signs
                            |
                            |  the resolution cascade  (Agentic SDLC spec, S2.3)
                            v
   KNOWLEDGE PLANE    everything the org knows, ACL-safe, token-free
                      Confluence . Jira . code . notes -> one Postgres -> MCP
```

The Agentic SDLC spec fixes the order in which an unknown must be resolved
before a human may be interrupted:

> `CONTEXT.md -> ARCHITECTURE.md -> project docs -> MCP knowledge-base tools ->
> human question (last resort)`

Rung 4 is named by the spec and not built by it. **EIL is rung 4.** The
framework's entire economic case rests on rung 4 being deep enough that rung 5 is
rare; in a real enterprise rungs 1-3 are whatever somebody wrote down and never
revised. Without a real rung 4 the cascade collapses to "ask a human" and the
framework becomes a rigorous machine for generating clarification tickets.

### 2.1 The business claim, in the audience's language

> Getting a feature to **Definition of Ready** takes us *[their number]* today.
> Here it is in twenty minutes, and it is better than what we write by hand,
> because every statement in it either cites a real page or is flagged as a
> question nobody has answered. And it cannot be signed off while an unknown is
> hidden.

DoR is exactly what `reqs.json` is: atomic testable requirements, GIVEN/WHEN/THEN
criteria, an accounted-for uncertainty ledger, and a named human's signature.
We are not introducing a concept; we are making an existing, universally
disliked gate fast and honest.

### 2.2 The value ladder, weakest to strongest

| Tier | Claim | Evidence |
|---|---|---|
| 1 | clarification round-trips avoided | **measured** count x a constant the room supplies out loud |
| 2 | late scope discovery / rework | mechanism shown, deliberately not numbered |
| 3 | **the incident class** — unspecified failure behaviour in a market-access control | named and demonstrated live; cost supplied by their own risk function |
| 4 | **the artefact chain is a compliance artefact** | shown on screen; obligations to demonstrate control design are met as a by-product |

Tier 4 is the strongest case for "adopt as the standard": it is not a
productivity claim (contestable, needs a quarter) but an evidence-production
claim (verifiable in ten seconds).

**Regulatory references must be verified at article level before they reach a
slide.** The substance is sound — pre-trade credit controls are mandated, and
unspecified failure behaviour in one is a control failure rather than a bug — but
we cite the obligation, not a paragraph number we did not check.

## 3. Scope

### In

1. `scoring` — the deterministic decision library
2. `reqs.json` schema and assembler
3. the analyser — 42 enumerated checks, 10 families
4. the renderer — HTML/markdown projections
5. CLI: `eil reqs elaborate | check | render | signoff | ledger`
6. the cascade recorder — grounding through EIL's `callTool`
7. the clarification ledger — measured, over `audit_log`
8. the synthetic PSR corpus — 8 Confluence pages, 5 Jira issues, dual projection
9. an `amp`/`copilot`/`fixture` agent runtime through the existing `ts/llm` seam

### Out, and said out loud on a slide

Design, Plan, Implement phases. The fast-mode execution profile. Publish-to-
Confluence. Refinement/baseline paths and `TRACE-007` exercise. The Python twin.
Cost-in-dollars reporting.

"Phase 1 of 4, deliberately, because Define is where the money is" is a stronger
position than four half-built phases.

### 3.1 One thing we will not do

No dollar figures on token or LLM spend. `llm_calls` and `metrics.usage_facts`
have no production writer today, and the money rows in the committed
`docs/metrics-report.html` are hand-seeded. `CliProvider` reports no token counts,
so wiring `logCall()` yields call volume and latency — real, and not dollars.
In a credibility demo one fabricated number costs the room.

## 4. The judgment / arithmetic / verification split

The Agentic SDLC spec splits judgment from arithmetic. Designing the corpus
proved a two-way split insufficient, and the failure case is instructive.

`PTR-420` — *"Decide in-flight order treatment on limit reduction"*, status Open,
no answer — scores highly on keyword retrieval for exactly the unknown it fails
to resolve. Arithmetic over retrieval scores would mark that unknown **grounded**
when the document found is a restatement of the question.

Retrieval scores measure aboutness, not answerhood. So:

| Component | Decides | Mechanism |
|---|---|---|
| **arithmetic** | is there anything worth reading | EIL's `top_score`, `score_gap`, `n_above_threshold`, `arms_contributing` vs `REGISTERED_CONSTANTS` |
| **the model** | does what I read *answer* this, and which exact words | bounded judgment: `answers: bool`, `quote: string`, `rationale` |
| **code** | is that quote verbatim in the cited document, does the citation resolve | substring check after re-fetch through `callTool("get_doc")` |

This yields the most valuable check in the catalogue: `CLARIFY-005`, a grounding
whose `quote` is not present verbatim in the document it cites. **A fabricated
citation becomes mechanically detectable**, with no model in the enforcement path.

And `CLARIFY-006` (lint): a cited quote containing hedging language is admissible
but must carry a residual, so the artefact does not inherit false confidence from
a source that hedged.

## 5. The artefact

`specs/<WORK-ITEM>/reqs.json`. Fields marked **[G]** are generated by the
assembler and recomputed by the analyser; disagreement is a gate error, which is
what makes the artefact tamper-evident.

```
metadata     work_item (resolved once, never invented) . title . delivery_type
             created_at . updated_at [staleness pin] . execution_profile
             generator {agent, model, version} . corpus_mode: fixtures | live

tree         RequirementNode (root)
  id            REQ-ROOT . REQ-ROOT.1 . REQ-ROOT.1.2   every child id extends its parent
  parent_id     absent on root; structural fields are absent, never empty
  node_key      durable slug of normative intent, e.g. limit-reduction.in-flight-orders
  score         {unknowns: Fib, complexity: Fib, magnitude [G], rationale}
  score_history[]  every pass, ordered by timestamp
  decision      leaf | decompose | clarify
  is_leaf [G]   derived from decision
  children[]    absent on a leaf
  acceptance_criteria[]  present only on a leaf
  grounding[]
  resolved_from context | architecture | project_docs | knowledge_base | human
  residual_ref  a review-zone (M=3) leaf must reference a residual

AC           id (AC-1, stable) . given . when . then[] (>=1) . stakeholder
             observable [G]

Clarification  node_id . question . options[{id, text, implication}] . answer
               answered_by {kind: human | knowledge_base, name} . answered_at
               resulting_detail . resolved_from . grounding[]

Grounding      source . doc_id ("confluence:page:12345")   <- THE SEAM
               title . url . quote . retrieved_at . trace_id  <- into audit_log
               hedged [G]  (lexicon lint)

Residual       kind: ResidualUncertainty | ResidualRisk | accepted_complexity
               node_id . statement . mitigation
               accepted_by {kind: human, name} . accepted_at

traceability [G]  AC id -> node id, inverted from authored addresses[]
coverage     [G]
signoff      approvers[{name, role, kind: "human", at}] . result: partial | failed
analysis     written by the analyser, never by the model
```

`grounding.doc_id` is an EIL document id. A requirement's evidence therefore
resolves back to the real page with one command against the id printed in the
artefact — the citation is a live pointer into the knowledge plane, not a
footnote. This costs no extra code because EIL already speaks that id.

## 6. The scoring library

Pure, side-effect free, no I/O. Every derived value lives here; the analyser
imports the same module so scorer and checker cannot disagree.

```
FIB               = [1, 2, 3, 5, 8, 13, 21]
magnitude(U, C)   = max(U, C)            (sum and euclidean supported, unused)
threshold_atomic          = 2
threshold_decompose       = 5
clarify_unknowns_floor    = 5
max_depth                 = 6
grounding_top_score_floor      \  the arithmetic half of S4, registered so the
grounding_score_gap_floor      /  escalation decision is auditable
hedge_lexicon             = [i think, roughly, haven't measured, check with, ...]
```

Decision table under `magnitude = max`:

| M = max(U,C) | zone | leaf | decompose | clarify (needs U >= 5) |
|---|---|---|---|---|
| 1-2 | atomic | yes | no | impossible |
| 3 | review | only with a referencing residual | yes | impossible |
| >= 5 | must break down | no | yes | when U >= 5 |

`decision_space` enumerates admissibility without choosing. `recommend_action`
adds the clarify drive rule. `check_decision` is what the gate calls: a leaf
additionally requires its payload, a decompose >= 2 children, a clarify >= 1
clarification. The table derives from the *relationship* between thresholds, so
it survives retuning the literals.

## 7. The check catalogue — 42 checks, 10 families

`--mode exit` is the gate: any error-severity finding blocks emission.
`--mode lint` downgrades sign-off checks to warnings for mid-loop use.
IDs named in the source spec are kept faithful to it.

| Family | n | Checks |
|---|---|---|
| SCHEMA | 5 | 001 body fails validation · 002 id does not extend parent · 003 root carries `parent_id` / non-root omits it · 004 leaf carries `children` or branch carries ACs · 005 unknown enum |
| SCORE | 5 | **001 stored magnitude != recomputed** · 002 U/C not a Fibonacci band · 003 final score != last history entry · 005 history unordered by timestamp · **006 clarify -> leaf without U strictly falling** |
| TREE | 6 | 001 decision inadmissible for zone · 002 decompose with < 2 children · 003 depth > max_depth · 004 branch at max depth without clarification or residual · 005 duplicate `node_key` · 006 uniform depth *(lint — the pre-drawn-tree forensic signature, spec S2.2)* |
| AC | 6 | 001 leaf without ACs · 002 missing given/when/then · 003 empty `then[]` · 004 id not unique · 005 outcome not observable per lexicon *(lint)* · 006 missing stakeholder |
| CLARIFY | 6 | **001 node ever scored `clarify` carries no clarification** · 002 clarification unanswered · 003 non-human answer without grounding · 004 option lacks an implication · **005 quote not verbatim in the cited document** · 006 hedged quote without a residual *(lint)* |
| UNCERT | 3 | 001 review-zone leaf without residual ref · 002 residual without a named human acceptor · **005 blind decomposition of an inherent unknown** |
| DEFER | 2 | **001 deferral marker in prose** (`TBD`, `TODO`, "decide later") · 002 same inside a recorded decision |
| TRACE | 3 | 001 AC absent from the traceability index · 002 index references a non-existent node · 007 id drift under a baseline |
| GATE | 4 | **001 result is `passed`** (only `partial`/`failed` admissible) · 002 emitted with error findings present · 003 missing a required role · **006 approver.kind != human** |
| META | 2 | 001 `updated_at` missing or malformed · **002 a generated field was hand-authored** |

Each check is a small pure function over the typed body, returning
`{id, severity, path, message}`. The list is a subset of the ~50 the source spec
describes for this phase, and the demo says so.

## 8. The corpus

One source of truth, two projections, generated together so they cannot drift.
If the pasted Confluence page and the ingested fixture differ, the two demo
modes diverge and the fallback stops being a fallback.

```
demo/corpus/source/*.yaml        authored once
   -> demo/corpus/confluence/*.md   paste-ready, synthetic banner  (humans)
   -> demo/corpus/jira/*.md         paste-ready                    (humans)
   -> demo/fixtures/*.json          EIL ingest shapes              (machines)
```

Space `PTR-DEMO`. Fictional components: `ptc-gateway` (order path),
`psr-limits` (limit service), `psr-cache` (in-process snapshot), `credit-admin`
(risk-ops amendment API). Venue `XDEM`. Counterparties `CPTY-ALPHA`, `CPTY-BRAVO`.
People: `d.mercer` (Risk Ops), `a.whitfield` (departed), `s.iyer` (Tech Lead),
`n.okafor` (QA).

**Register: thin, hedged, partly stale — real Confluence, not tidy Confluence.**
Prose over tables. Numbers buried mid-paragraph. Inconsistent terminology across
pages. One page that is mostly a meeting note. One page plainly out of date and
not marked as such. Unhelpful titles. This is a load-bearing decision: tidy
synthetic docs make retrieval look easy and the demo look staged; messy ones make
the hard part visible, which is the part being funded.

Every page carries a synthetic banner. An unmarked fake document in real
Confluence is a hazard that outlives the demo.

| # | Page | Role |
|---|---|---|
| 1 | Pre-Trade Risk Controls — Architecture Overview | the map; names every component |
| 2 | Gateway Notes | **grounds** hot-path budget and staleness cutoff — hedged, stale, badly titled |
| 3 | PSR Limit Model — notes | **grounds** gross notional, netting EOD only |
| 4 | Market Access Controls — Regulatory Obligations | **grounds** fail-closed as mandatory |
| 5 | Risk Ops Runbook — Limit Amendments | **grounds** maker-checker dual control |
| 6 | Credit Service Deployment Runbook | **planted AWS key** -> quarantine beat |
| 7 | Counterparty Static Data *(restricted `grp-risk-ops`)* | **ACL fail-closed** beat |
| 8 | PSR Cache Refresh Design | **conflicts with #3** on granularity -> escalate |

| Key | Issue | Role |
|---|---|---|
| PTR-401 | Intraday PSR limit amendment | **the elaboration input** — deliberately thin |
| PTR-388 | Credit check rejected valid orders after psr-limits restart | past incident; carries the fail-closed tension honestly |
| PTR-392 | Add maker-checker to credit-admin limit changes *(Done)* | corroborates page 5 |
| PTR-415 | psr-cache staleness alerting *(In Progress)* | links to page 8 |
| PTR-420 | **Decide in-flight order treatment on limit reduction *(Open)*** | corroborates the escalation |

Deliberately absent: in-flight treatment on limit reduction, and any FX or
cross-currency source. Those escalate, and should.

### 8.1 Designed outcomes

| Unknown | Resolves from | Outcome |
|---|---|---|
| hot-path latency budget | page 2, hedged | grounded + **residual** (source hedged) |
| fail-open or fail-closed on staleness | page 4, corroborated by PTR-388 | grounded |
| gross vs net exposure | page 3 | grounded |
| who authorises an amendment | page 5 + PTR-392 | grounded |
| in-flight orders on limit **reduction** | nothing | **escalates**, corroborated by PTR-420 |
| amendment granularity | pages 3 and 8 disagree | **escalates** — `score_gap` collapses |
| FX source for cross-currency | nothing | **escalates** |

Four grounded, three escalated. A 100% hit rate would look fake and would
conceal the escalation mechanism, which is the safety feature.

## 9. Two-mode operation

The same corpus reached two ways. Identical content, so identical behaviour.

| Mode | How | When |
|---|---|---|
| `fixtures` | `eil ingest confluence --fixture demo/fixtures/*.json` | development here; rehearsal; fallback if the corp proxy misbehaves |
| `live` | `eil ingest confluence --space PTR-DEMO` / `jira --project PTR` | on the work machine, after the pages are created |

`metadata.corpus_mode` is stamped into the artefact, so no run can be
misrepresented as the other.

**Embeddings are optional.** `@huggingface/transformers` is an
`optionalDependency` that has not materialised locally and may not behind a
corporate proxy. The four lexical arms are complete. `demo/run.mjs` step 7 must
become `{optional: true}`; the vector arm is a bonus, never a dependency.
`EIL_EMBED_PROVIDER=fake` is **not** an acceptable substitute — it is
hash-seeded and semantically meaningless, and must never be narrated as
semantic search.

## 10. Agent runtime

Through the existing `ts/llm` seam. No new dependency, no API key, no gateway.

| Provider | Use |
|---|---|
| `copilot` (`copilot -p`) | the work machine — chosen runtime |
| `amp` (`amp -x`) | development and rehearsal here; installed at `~/.local/bin/amp` |
| `fixture` (**new**) | replays a recorded response; makes the pipeline deterministic in tests and rehearsal |

Selected by `EIL_LLM_PROVIDER`. MaaS keeps its seam but carries only non-frontier
beta models and is not a demo path.

Every elaboration call goes through `logCall()`, which today has no callers. This
gives `llm_calls` its first production writer, so `vw_llm_calls` and
`vw_cost_per_run` stop rendering "no data" — call volume and latency, not dollars.

The model emits **only bounded judgments**: `unknowns` and `complexity` from
`FIB`, a one-line rationale, `answers`/`quote` for a grounding attempt, and
acceptance-criterion prose. Every derived value, admissibility decision and
verdict is computed by `scoring` and re-checked by the analyser.

## 11. The demo

| # | Beat | Min | Mode | Risk |
|---|---|---|---|---|
| 1 | nine invented facts about our own credit check | 5 | pre-baked | none |
| 2 | AI proposes -> code decides -> human signs | 2 | static | none |
| 3 | the grounding rung: 4 cited, 3 escalated | 5 | live | low |
| 4 | **break the gate six ways** | 7 | live | ~zero variance |
| 5 | the receipt: citation -> real page; ACL; quarantine | 5 | live | low |
| 6 | "that was synthetic — this is ours" | 2 | **LIVE** | isolated |
| 7 | the four tiers, and the ask | 4 | static | none |

The only pre-baked element is the LLM output; the only live elements are
deterministic. That is the inverse of a normal AI demo and it is the right way
round: a live model in front of executives is the highest-variance object in the
room, and a live static analyser is a rock.

### 11.1 Beat 1

An ungated agent asked for requirements for PTR-401 will confidently invent: a
latency budget in milliseconds; **fail-open** on limit-service unavailability;
in-flight orders continuing on the old limit; immediate effect; single-approver
authorisation; net exposure; "amendments are logged"; a granularity; an API
shape. It will also state the 5s staleness cutoff as fact, laundering the source's
hedge.

The demo is not us pointing at those. It is the firm's own engineers recognising
them. Pre-baked, with the standing offer: *"I will run it again, right now, on
any feature you name."* If taken, it wins outright; if not, the offer has already
won, and it is safe because the behaviour is robust.

### 11.2 Beat 4 — the six tampers

| Tamper | Refusal | Point |
|---|---|---|
| stored magnitude 5 -> 2 | `SCORE-001` | the model's arithmetic is never trusted |
| type `TBD` into a note | `DEFER-001` | "decide later" is not a completion state |
| delete a clarification, keep the `clarify` decision | `CLARIFY-001` | the audit trail cannot be quietly shortened |
| **change one word of a cited quote** | `CLARIFY-005` | **a citation cannot be fabricated** |
| `approver.kind` -> `agent` | `GATE-006` | **the AI cannot sign its own homework** |
| hand-edit the coverage index | `META-002` + `TRACE-001` | derived fields are generated, never authored |

Same input, same output, no model in the enforcement path. Five if time is short;
`CLARIFY-005` and `GATE-006` are the two that must survive a cut.

## 12. Error handling and failure modes

| If | Then |
|---|---|
| corp proxy blocks live ingest | fall back to `--fixture`; beat 6 is dropped, nothing else changes |
| `copilot`/`amp` unavailable at run time | the artefact is pre-baked; elaboration is not on the live path |
| embeddings unavailable | lexical arms only; say so; no `fake` provider |
| a grounding cannot be verified | the artefact is **refused**, not downgraded — this is a feature and gets demonstrated |
| the analyser finds an error mid-demo | read the check id aloud; that *is* the product working |
| Grafana | not shown. Needs Docker and a Postgres backend. `eil report` instead. |

## 13. Testing

Extends the existing 338-test vitest suite; `fileParallelism: false` stays.

- `scoring` — table-driven over the full `(U, C)` cross-product; admissibility
  and recommendation asserted against the decision table, not reimplemented.
- assembler — every **[G]** field: authored-then-recomputed must be identical;
  id allocation monotonic above the retired maximum.
- analyser — **one test per check id**, each with a minimal failing body and a
  minimal passing one. This is also the tamper rehearsal: the six demo tampers
  are six of these tests, so a green suite proves the demo works.
- cascade — `PTR-420` as a fixture: asserts a question-shaped document does
  **not** resolve its own unknown.
- `CLARIFY-005` — a one-word quote mutation must be caught.
- corpus — the two projections must have byte-identical bodies.

## 14. Honest caveats to volunteer

Volunteering these buys more credibility than the beats they qualify.

- **ACL is owner-only in live mode.** Every connector stamps `acl_groups: []`;
  multi-group visibility works in fixture mode because fixtures carry the field.
  Do not claim multi-user ACL on live data.
- ~87% of chunks exceed the embedding window (`eil audit` reports
  `chunks_over_embed_window`).
- BM25 is schema and stats only; ranking is still `ts_rank`.
- Code search is exact-equality and unranked (alphabetical by path).
- Phase 1 of 4. 42 of ~50 checks. No cost-in-dollars.
- The corpus is synthetic and every page says so.

## 15. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| overnight scope (~1,800 lines + corpus) | high | build order has a working demo at every cut line; renderer before analyser |
| elaboration output is weak or wrong-shaped | medium | pre-baked and reviewable; iterate tonight, never live |
| corpus register unconvincing to practitioners | medium | thin/hedged register approved; one page reviewed before the rest |
| live ingest fails at work | low | fixtures are behaviourally identical; beat 6 is isolated by design |
| regulatory reference challenged | medium | cite obligations, not article numbers; verify before slides |
| a check has a false positive on stage | low | one test per check id; the six tampers are tests |

## 16. Sequencing

Parallel, because it does not fit sequentially.

**Krunal:** create the 8 pages and 5 issues in work Confluence/Jira from
`demo/corpus/` · `pnpm add @huggingface/transformers` and confirm
`eil demo:preflight` (optional, not blocking) · review the pre-baked artefact ·
rehearse the six tampers · fill in the tier-1 constant to ask the room for.

**Here:** `scoring` -> schema + assembler -> renderer -> **analyser** -> CLI ->
*checkpoint* -> cascade recorder -> ledger -> corpus generator + 13 documents ->
elaboration prompt -> tamper and rehearsal scripts.

Cut lines: after the renderer there is a demo; after the analyser the centrepiece
works; after the ledger the business number is machine-generated.
