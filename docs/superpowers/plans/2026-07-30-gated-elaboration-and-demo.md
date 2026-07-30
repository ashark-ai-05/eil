# Gated Requirements Elaboration + PSR Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 1 (Define) of a gated agentic delivery pipeline — `feature.md → reqs.json` — where the model emits only bounded judgments, a deterministic library computes every derived value, a 42-check analyser refuses the artefact on any error, and grounding resolves through EIL with mechanically verified citations.

**Architecture:** A pure `scoring` library owns all arithmetic and admissibility. A zod schema defines `reqs.json`; an assembler generates every derived field; an analyser recomputes them and refuses on disagreement. Grounding walks a 5-rung resolution cascade whose 4th rung is EIL's `callTool`, and every citation's quote is verified verbatim against the cited document. A synthetic pre-trade-risk corpus is authored once and projected twice (paste-ready markdown for Confluence/Jira, fixture JSON for EIL) so the demo behaves identically live and offline.

**Tech Stack:** TypeScript (Node 22+, ESM, no build step — `tsx`), zod 3.24, vitest 3, commander 13, PGlite/Postgres via existing `ts/db.ts`, biome 1.9.

## Global Constraints

- **Relative imports MUST carry `.js`** — `import { magnitude } from "./scoring.js"`. NodeNext resolution; a missing extension fails `pnpm typecheck`.
- **biome:** 2-space indent, 100-column line width, double quotes. `pnpm lint` must pass.
- **Tests live in `ts/tests/*.test.ts`** — vitest `include` glob is `ts/tests/**/*.test.ts`. A test anywhere else does not run.
- **`fileParallelism: false`** is already set; do not change it.
- **No new runtime dependencies.** zod, commander, pg, PGlite are already present. Adding a dependency requires the corp proxy to cooperate and is out of scope.
- **`any` is allowed** (biome `noExplicitAny: "off"`), non-null assertion allowed. Prefer types anyway.
- **Field naming is camelCase in TypeScript, and the JSON on disk is camelCase too.** Do not introduce snake_case; the source spec uses snake_case prose but this repo's `CanonicalDoc` is camelCase and consistency wins.
- **The schema is permissive exactly where the gate is strict.** `signoff.result`, `approver.kind`, and `score.magnitude` MUST accept wrong values so the named check fires with a readable message instead of a zod error. This is load-bearing for the demo.
- **Every corpus document carries a synthetic banner.** An unmarked fake document in real Confluence is a hazard that outlives the demo.
- **Never narrate `EIL_EMBED_PROVIDER=fake` as semantic search.** It is hash-seeded and meaningless.
- Spec: `docs/superpowers/specs/2026-07-30-gated-elaboration-and-demo-design.md`.

## File Structure

| Path | Responsibility |
|---|---|
| `ts/reqs/constants.ts` | `FIB`, `REGISTERED_CONSTANTS`, the three lexicons. No logic. |
| `ts/reqs/scoring.ts` | magnitude, zone, `decisionSpace`, `recommendAction`, `checkDecision`. Pure, no I/O. |
| `ts/reqs/schema.ts` | zod schema for `reqs.json` + inferred types + `Finding`. |
| `ts/reqs/assemble.ts` | generates every `[G]` field: `magnitude`, `isLeaf`, `observable`, `hedged`, `traceability`, `coverage`. |
| `ts/reqs/render.ts` | `reqs.json` → HTML and markdown projections. Pure projection. |
| `ts/reqs/analyse.ts` | check registry, runner, `exit`/`lint` modes. |
| `ts/reqs/checks/structural.ts` | SCHEMA (5), TREE (6), META (2) |
| `ts/reqs/checks/scoring.ts` | SCORE (5), UNCERT (3) |
| `ts/reqs/checks/content.ts` | AC (6), DEFER (2) |
| `ts/reqs/checks/provenance.ts` | CLARIFY (6), TRACE (3), GATE (4) |
| `ts/reqs/ground.ts` | the 5-rung resolution cascade + verbatim quote verification. |
| `ts/reqs/ledger.ts` | the clarification ledger over `reqs.json` + `audit_log`. |
| `ts/reqs/elaborate.ts` | drives the bounded-judgment loop through `ts/llm`. |
| `ts/reqs/prompt.ts` | the elaboration prompts. Text only. |
| `ts/llm/index.ts` | **modify** — add `FixtureProvider`. |
| `ts/cli.ts` | **modify** — add the `reqs` command group. |
| `demo/corpus/source/*.yaml` | the corpus, authored once. |
| `scripts/build-corpus.ts` | projects the source into markdown + fixtures. |
| `demo/corpus/confluence/*.md`, `demo/corpus/jira/*.md` | **generated** — paste-ready. |
| `demo/fixtures/*.json` | **generated** — EIL ingest shapes. |
| `demo/tamper.mjs` | the six tamper demonstrations. |
| `demo/run.mjs` | **modify** — embed step becomes optional. |

Tests: `ts/tests/reqs-scoring.test.ts`, `reqs-schema.test.ts`, `reqs-assemble.test.ts`, `reqs-analyse.test.ts`, `reqs-ground.test.ts`, `reqs-corpus.test.ts`.

---

## Task 1: The synthetic PSR corpus

**Why first:** this is on Krunal's critical path, not the code's. He must create 8 Confluence pages and 5 Jira issues by hand in the work estate before the demo. Everything else can wait; this cannot.

**Files:**
- Create: `demo/corpus/source/confluence.yaml`, `demo/corpus/source/jira.yaml`
- Create: `scripts/build-corpus.ts`
- Create (generated): `demo/corpus/confluence/*.md`, `demo/corpus/jira/*.md`, `demo/corpus/README.md`, `demo/fixtures/*.json`
- Test: `ts/tests/reqs-corpus.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `demo/fixtures/*.json` conforming to the shapes in `tests/fixtures/confluence_page.json` and `tests/fixtures/jira_issue.json`; `buildCorpus(): { pages: ConfluenceFixture[]; issues: JiraFixture[] }` exported from `scripts/build-corpus.ts`.

### Fixture shapes (copy exactly — EIL's ingest already parses these)

Confluence: `{ id, title, url, author, created, updated, ancestors: string[], acl_groups: string[], body }` — snake_case, because that is the connector's wire shape.
Jira: `{ key, url, fields: { summary, status, issuetype, project, reporter, created, updated, description, comments: [{ author, body }] } }`.

### The synthetic banner — prepended to every body, verbatim

```
> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.
```

### Register — read this before writing a word

Thin, hedged, partly stale. **Real Confluence, not tidy Confluence.** Prose over tables. Numbers buried mid-paragraph, never in an SLO table. Terminology drifts between pages (`PSR`, `presettlement`, `credit exposure` all appear). Unhelpful titles. One page is mostly a meeting note. One page is plainly out of date and not marked as such. This is load-bearing: tidy synthetic docs make retrieval look easy and the demo look staged.

Fictional names — use these and no others: components `ptc-gateway`, `psr-limits`, `psr-cache`, `credit-admin`; venue `XDEM`; counterparties `CPTY-ALPHA`, `CPTY-BRAVO`; people `d.mercer` (Risk Ops), `a.whitfield` (departed), `s.iyer` (Tech Lead), `n.okafor` (QA). Space `PTR-DEMO`, Jira project `PTR`.

### The 8 Confluence pages — content specification

Each row states the facts the page MUST contain, because the demo's grounding outcomes depend on them. Prose style is the author's choice within the register above.

| id | title | ancestors | acl_groups | MUST contain |
|---|---|---|---|---|
| `ptrd-1` | `Pre-Trade Risk Controls — Architecture Overview` | `["PTR-DEMO"]` | `[]` | names all four components and their order in the path; links to PTR-388; mentions that limit admin is "documented elsewhere" without saying where |
| `ptrd-2` | `Gateway Notes` | `["PTR-DEMO"]` | `[]` | **hedged**: 250us wire-to-wire target; PSR check "under about 40us"; reads local snapshot not `psr-limits`; network call to `psr-limits` is 2-8ms and "a non starter in the order path"; cache refresh push, "was aiming for 250ms end to end", "haven't measured recently"; "There's a staleness cutoff, I think 5s, after which we reject. Check with the psr-limits team."; ends with `TODO: document the add-on factor refresh properly`. No labels. Author `a.whitfield`, `updated` 14 months before `created` of PTR-401 |
| `ptrd-3` | `PSR limit model - notes` | `["PTR-DEMO"]` | `[]` | gross notional × tenor add-on factor; **netting applied end-of-day only, never intraday**; limits held "per counterparty and legal entity" |
| `ptrd-4` | `Market Access Controls — Regulatory Obligations` | `["PTR-DEMO","Compliance"]` | `[]` | any pre-trade control that cannot be evaluated MUST reject the order; bypass is never permitted; states the obligation generically, **no article numbers** |
| `ptrd-5` | `Risk Ops Runbook — Limit Amendments` | `["PTR-DEMO","Runbooks"]` | `[]` | maker-checker: one Risk Ops user raises, a second different user approves; `credit-admin` enforces it; references PTR-392 |
| `ptrd-6` | `Credit Service Deployment Runbook` | `["PTR-DEMO","Runbooks"]` | `[]` | mundane deploy steps **plus** `aws_access_key_id = AKIAIOSFODNN7EXAMPLE` and `DATABASE_URL=postgres://svc:hunter2correct@db.internal:5432/psr` — this page must be quarantined by EIL's secret scanner |
| `ptrd-7` | `Counterparty Static Data` | `["PTR-DEMO"]` | `["grp-risk-ops"]` | limit values for `CPTY-ALPHA` and `CPTY-BRAVO`; the reason it is restricted |
| `ptrd-8` | `PSR Cache Refresh Design` | `["PTR-DEMO"]` | `[]` | **must conflict with `ptrd-3`**: states the cache is keyed "per counterparty" with no mention of legal entity; references PTR-415 |

**Deliberately absent from all 8 pages:** what happens to in-flight orders when a limit is *reduced*; any FX or cross-currency rate source. Do not add them.

### The 5 Jira issues

| key | summary | status | type | MUST contain |
|---|---|---|---|---|
| `PTR-401` | `Intraday PSR limit amendment` | `To Do` | Story | one paragraph of motivation (collateral posted intraday cannot be used until next day; no intraday mechanism for a credit-event reduction); "Should cover both increases and decreases"; a comment from `d.mercer` asking about the October collateral cycle. **No mention of** in-flight orders, dual control, latency, granularity, or reduction semantics |
| `PTR-388` | `Credit check rejected valid orders after psr-limits restart` | `Done` | Bug | fail-closed behaviour caused a rejection burst; comment confirms rejection was correct per the market access page and the fix was cache warm-up, **not** relaxing the check |
| `PTR-392` | `Add maker-checker to credit-admin limit changes` | `Done` | Story | corroborates `ptrd-5`; names two distinct Risk Ops approvers |
| `PTR-415` | `psr-cache staleness alerting` | `In Progress` | Task | 1s alerting threshold; references `ptrd-8` |
| `PTR-420` | `Decide in-flight order treatment on limit reduction` | `Open` | Task | **states the question and contains no answer.** A comment from `s.iyer`: "raised at the risk forum, no decision yet." This proves the escalation is real |

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/reqs-corpus.test.ts
import { describe, expect, it } from "vitest";
import { buildCorpus } from "../../scripts/build-corpus.js";

describe("corpus", () => {
  it("emits 8 pages and 5 issues", () => {
    const { pages, issues } = buildCorpus();
    expect(pages).toHaveLength(8);
    expect(issues).toHaveLength(5);
  });

  it("banners every body so nothing can be mistaken for production", () => {
    const { pages, issues } = buildCorpus();
    for (const p of pages) expect(p.body).toContain("SYNTHETIC DEMO CONTENT");
    for (const i of issues) expect(i.fields.description).toContain("SYNTHETIC DEMO CONTENT");
  });

  it("restricts only the counterparty static data page", () => {
    const { pages } = buildCorpus();
    const restricted = pages.filter((p) => p.acl_groups.length > 0);
    expect(restricted.map((p) => p.id)).toEqual(["ptrd-7"]);
    expect(restricted[0]!.acl_groups).toEqual(["grp-risk-ops"]);
  });

  it("plants a detectable secret in exactly one page", () => {
    const { pages } = buildCorpus();
    const withKeys = pages.filter((p) => p.body.includes("AKIA"));
    expect(withKeys.map((p) => p.id)).toEqual(["ptrd-6"]);
  });

  it("leaves the two escalation gaps genuinely unanswered", () => {
    const { pages } = buildCorpus();
    const all = pages.map((p) => p.body).join("\n").toLowerCase();
    expect(all).not.toContain("in-flight");
    expect(all).not.toContain("fx rate");
  });

  it("keeps ptrd-3 and ptrd-8 in conflict on granularity", () => {
    const { pages } = buildCorpus();
    const three = pages.find((p) => p.id === "ptrd-3")!.body;
    const eight = pages.find((p) => p.id === "ptrd-8")!.body;
    expect(three).toContain("legal entity");
    expect(eight).not.toContain("legal entity");
  });

  it("PTR-420 states a question and answers nothing", () => {
    const { issues } = buildCorpus();
    const t = issues.find((i) => i.key === "PTR-420")!;
    expect(t.fields.status).toBe("Open");
    expect(t.fields.comments.some((c) => /no decision yet/i.test(c.body))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-corpus.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/build-corpus.js'`

- [ ] **Step 3: Author the corpus source**

Write `demo/corpus/source/confluence.yaml` and `demo/corpus/source/jira.yaml` holding the 8 pages and 5 issues per the tables above. Use a plain hand-rolled parser or plain `.ts` data modules — **do not add a YAML dependency.** If a dependency would be needed, use `demo/corpus/source/confluence.ts` exporting a typed array instead; that is the preferred form.

Then write `scripts/build-corpus.ts`:

```ts
/**
 * The corpus is authored once and projected twice — paste-ready markdown for a
 * human to create in Confluence/Jira, and fixture JSON for EIL to ingest. If
 * the two ever drift the demo's live and offline modes diverge, so both come
 * from one source and a test asserts the bodies are byte-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFLUENCE_SOURCE, JIRA_SOURCE } from "../demo/corpus/source/confluence.js";

export const BANNER = [
  "> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability",
  "> demonstration. Not a production reference. Do not cite in design or change",
  "> documentation.",
].join("\n");

export interface ConfluenceFixture {
  id: string;
  title: string;
  url: string | null;
  author: string;
  created: string;
  updated: string;
  ancestors: string[];
  acl_groups: string[];
  body: string;
}

export interface JiraFixture {
  key: string;
  url: string;
  fields: {
    summary: string;
    status: string;
    issuetype: string;
    project: string;
    reporter: string;
    created: string;
    updated: string;
    description: string;
    comments: { author: string; body: string }[];
  };
}

const withBanner = (body: string) => `${BANNER}\n\n${body.trim()}\n`;

export function buildCorpus(): { pages: ConfluenceFixture[]; issues: JiraFixture[] } {
  const pages = CONFLUENCE_SOURCE.map((p) => ({ ...p, body: withBanner(p.body) }));
  const issues = JIRA_SOURCE.map((i) => ({
    ...i,
    fields: { ...i.fields, description: withBanner(i.fields.description) },
  }));
  return { pages, issues };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

export function emit(root = process.cwd()): void {
  const { pages, issues } = buildCorpus();
  for (const p of pages) {
    write(join(root, "demo/fixtures", `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`);
    write(
      join(root, "demo/corpus/confluence", `${p.id}.md`),
      `# ${p.title}\n\n_Space PTR-DEMO · parent: ${p.ancestors.join(" / ")}` +
        `${p.acl_groups.length ? ` · restrict to: ${p.acl_groups.join(", ")}` : ""}_\n\n${p.body}`,
    );
  }
  for (const i of issues) {
    write(join(root, "demo/fixtures", `${i.key}.json`), `${JSON.stringify(i, null, 2)}\n`);
    write(
      join(root, "demo/corpus/jira", `${i.key}.md`),
      `# ${i.key} — ${i.fields.summary}\n\n_Project PTR · ${i.fields.issuetype} · ` +
        `${i.fields.status} · reporter ${i.fields.reporter}_\n\n${i.fields.description}\n\n` +
        i.fields.comments.map((c) => `**Comment — ${c.author}**\n\n${c.body}`).join("\n\n"),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) emit();
```

Add to `package.json` scripts: `"corpus:build": "tsx scripts/build-corpus.ts"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-corpus.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Generate the projections and verify EIL ingests them**

```bash
pnpm corpus:build
export EIL_DATABASE_URL=pglite://.eil-corpus-check
pnpm eil db migrate
for f in demo/fixtures/ptrd-*.json; do pnpm eil ingest confluence --fixture "$f"; done
for f in demo/fixtures/PTR-*.json; do pnpm eil ingest jira --fixture "$f"; done
pnpm eil quarantine list
pnpm eil search "staleness cutoff"
```

Expected: 13 upserts; `quarantine list` shows `ptrd-6` with an `AKIA…MPLE` hint; the search returns `confluence:page:ptrd-2` (Gateway Notes). If the search misses, the page's prose needs the words a person would actually type — fix the corpus, not the search.

- [ ] **Step 6: Write the paste order README**

`demo/corpus/README.md` listing: create the space `PTR-DEMO`; create pages in id order (`ptrd-1` … `ptrd-8`); restrict `ptrd-7` to `grp-risk-ops`; create issues `PTR-388`, `PTR-392`, `PTR-415`, `PTR-420` before `PTR-401`; then set `PTR-401`'s links to relate to `PTR-392`, `PTR-415`, `PTR-420`. Note that `ptrd-2`'s "last updated" must be backdated if the wiki allows it, and that it does not matter if it cannot be.

- [ ] **Step 7: Commit**

```bash
git add demo/corpus demo/fixtures scripts/build-corpus.ts ts/tests/reqs-corpus.test.ts package.json
git commit -m "feat: synthetic pre-trade PSR corpus, projected to paste-ready docs and EIL fixtures"
```

---

## Task 2: Constants and the scoring library

**Files:**
- Create: `ts/reqs/constants.ts`, `ts/reqs/scoring.ts`
- Test: `ts/tests/reqs-scoring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FIB: readonly [1,2,3,5,8,13,21]`, `REGISTERED_CONSTANTS`, `HEDGE_LEXICON`, `DEFERRAL_MARKERS`, `OBSERVABILITY_LEXICON` from `constants.js`
  - `type Fib = 1|2|3|5|8|13|21`, `type Decision = "leaf"|"decompose"|"clarify"`, `type Zone = "atomic"|"review"|"must_break_down"`
  - `isFib(n: number): n is Fib`, `magnitude(u: Fib, c: Fib): Fib`, `zone(m: Fib): Zone`, `decisionSpace(u: Fib, c: Fib): Decision[]`, `recommendAction(u: Fib, c: Fib, priorU?: Fib): Decision`, `hasHedge(text: string): boolean`, `hasDeferral(text: string): boolean`, `isObservable(text: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/reqs-scoring.test.ts
import { describe, expect, it } from "vitest";
import { FIB, REGISTERED_CONSTANTS as K } from "../reqs/constants.js";
import {
  decisionSpace,
  hasDeferral,
  hasHedge,
  isFib,
  isObservable,
  magnitude,
  recommendAction,
  zone,
} from "../reqs/scoring.js";

describe("magnitude", () => {
  it("is max, and is therefore always itself a Fibonacci band", () => {
    for (const u of FIB) for (const c of FIB) expect(isFib(magnitude(u, c))).toBe(true);
    expect(magnitude(2, 8)).toBe(8);
    expect(magnitude(13, 3)).toBe(13);
  });
});

describe("zone", () => {
  it("derives from the relationship between thresholds, not from literals", () => {
    expect(zone(1)).toBe("atomic");
    expect(zone(K.thresholdAtomic)).toBe("atomic");
    expect(zone(3)).toBe("review");
    expect(zone(K.thresholdDecompose)).toBe("must_break_down");
    expect(zone(21)).toBe("must_break_down");
  });
});

describe("decisionSpace", () => {
  it("permits only leaf in the atomic zone", () => {
    expect(decisionSpace(1, 2)).toEqual(["leaf"]);
  });
  it("permits leaf or decompose in the review zone", () => {
    expect(decisionSpace(3, 3).sort()).toEqual(["decompose", "leaf"]);
  });
  it("forbids leaf at or above the decompose threshold", () => {
    expect(decisionSpace(2, 8)).not.toContain("leaf");
  });
  it("admits clarify only once unknowns reach the floor", () => {
    expect(decisionSpace(3, 8)).not.toContain("clarify");
    expect(decisionSpace(8, 8)).toContain("clarify");
  });
  it("never admits clarify below the floor however complex", () => {
    expect(decisionSpace(2, 21)).toEqual(["decompose"]);
  });
});

describe("recommendAction", () => {
  it("routes to clarify when a structural pass failed to move the unknowns", () => {
    expect(recommendAction(8, 8, 8)).toBe("clarify");
    expect(recommendAction(13, 5, 8)).toBe("clarify");
  });
  it("decomposes when the unknowns are actually falling", () => {
    expect(recommendAction(5, 8, 13)).toBe("decompose");
  });
  it("leafs in the atomic and review zones", () => {
    expect(recommendAction(1, 1)).toBe("leaf");
    expect(recommendAction(3, 2)).toBe("leaf");
  });
});

describe("lexicons", () => {
  it("detects hedged prose so the artefact cannot launder a source's uncertainty", () => {
    expect(hasHedge("There's a staleness cutoff, I think 5s")).toBe(true);
    expect(hasHedge("Haven't measured recently")).toBe(true);
    expect(hasHedge("The cutoff is 5s, asserted in the runbook")).toBe(false);
  });
  it("detects deferral markers", () => {
    expect(hasDeferral("latency budget TBD")).toBe(true);
    expect(hasDeferral("we will decide later")).toBe(true);
    expect(hasDeferral("the budget is 40us")).toBe(false);
  });
  it("treats an outcome as observable when it names something checkable", () => {
    expect(isObservable("the order is rejected with code 4001")).toBe(true);
    expect(isObservable("the system behaves correctly")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-scoring.test.ts`
Expected: FAIL — `Cannot find module '../reqs/constants.js'`

- [ ] **Step 3: Write the implementation**

```ts
// ts/reqs/constants.ts
/**
 * The single register every derived value is computed from. The human-readable
 * rubric and the analyser both read these, so documentation and code cannot
 * diverge and scorer and checker cannot disagree.
 */

/** Estimation-poker bands: uncertainty grows super-linearly and false precision
 *  between bands is forbidden. Under magnitude = max, M is always itself a band,
 *  which is what lets the zone predicate collapse to a small decision table. */
export const FIB = [1, 2, 3, 5, 8, 13, 21] as const;

export const REGISTERED_CONSTANTS = {
  /** M at or below this is atomic — finalise as a leaf. */
  thresholdAtomic: 2,
  /** M at or above this must break down. */
  thresholdDecompose: 5,
  /** Unknowns at or above this make `clarify` admissible. */
  clarifyUnknownsFloor: 5,
  /** Recursion ceiling; a branch at this depth must carry a clarification or residual. */
  maxDepth: 6,
  /** Retrieval arithmetic: below this top score there is nothing worth reading. */
  groundingTopScoreFloor: 0.12,
  /** Below this gap between rank 1 and rank 5 the sources disagree — escalate. */
  groundingScoreGapFloor: 0.03,
} as const;

/** A source that hedges must not be cited as if it asserted. Lint, not error:
 *  the grounding stands, it just has to carry a residual. */
export const HEDGE_LEXICON = [
  "i think",
  "roughly",
  "haven't measured",
  "havent measured",
  "check with",
  "not sure",
  "tbc",
  "probably",
  "should be",
  "approximately",
  "afaik",
  "from memory",
  "i believe",
  "was aiming for",
] as const;

/** Scanned over AUTHORED prose only — never over `grounding[].quote`, which must
 *  stay verbatim and may legitimately quote someone else's TODO. */
export const DEFERRAL_MARKERS = [
  "tbd",
  "todo",
  "decide later",
  "to be confirmed",
  "to be decided",
  "fixme",
  "???",
] as const;

/** An honestly-labelled lint heuristic: an outcome counts as observable if it
 *  names something a test could read. Write genuinely checkable outcomes and let
 *  the lexicon fall out — do not game it. */
export const OBSERVABILITY_LEXICON = [
  "reject",
  "accept",
  "return",
  "log",
  "emit",
  "alert",
  "record",
  "increment",
  "status",
  "code",
  "within",
  "count",
  "error",
  "response",
  "field",
  "header",
  "metric",
  "snapshot",
] as const;
```

```ts
// ts/reqs/scoring.ts
/**
 * Every derived value, admissibility rule and recommendation. Pure and
 * side-effect free: the model emits only bounded judgments (two bands plus a
 * rationale) and everything downstream is computed here. The analyser imports
 * this same module rather than re-deriving the rules.
 */
import { FIB, HEDGE_LEXICON, DEFERRAL_MARKERS, OBSERVABILITY_LEXICON, REGISTERED_CONSTANTS as K } from "./constants.js";

export type Fib = (typeof FIB)[number];
export type Decision = "leaf" | "decompose" | "clarify";
export type Zone = "atomic" | "review" | "must_break_down";

export const isFib = (n: number): n is Fib => (FIB as readonly number[]).includes(n);

/** max, by default and in practice. Guarantees M is itself a band. */
export const magnitude = (u: Fib, c: Fib): Fib => Math.max(u, c) as Fib;

export const zone = (m: Fib): Zone =>
  m <= K.thresholdAtomic ? "atomic" : m < K.thresholdDecompose ? "review" : "must_break_down";

/** Enumerates what is admissible without choosing. */
export function decisionSpace(u: Fib, c: Fib): Decision[] {
  const z = zone(magnitude(u, c));
  const out: Decision[] = [];
  if (z === "atomic" || z === "review") out.push("leaf");
  if (z !== "atomic") out.push("decompose");
  if (z === "must_break_down" && u >= K.clarifyUnknownsFloor) out.push("clarify");
  return out;
}

/**
 * Adds the clarify drive rule: when a structural pass leaves the unknowns at or
 * above where they started and at or above the floor, decomposing again is
 * blind — the unknown is inherent and a human has to be asked.
 */
export function recommendAction(u: Fib, c: Fib, priorU?: Fib): Decision {
  if (priorU !== undefined && u >= priorU && u >= K.clarifyUnknownsFloor) return "clarify";
  const z = zone(magnitude(u, c));
  return z === "must_break_down" ? "decompose" : "leaf";
}

const containsAny = (text: string, needles: readonly string[]): boolean => {
  const t = text.toLowerCase();
  return needles.some((n) => t.includes(n));
};

export const hasHedge = (text: string): boolean => containsAny(text, HEDGE_LEXICON);
export const hasDeferral = (text: string): boolean => containsAny(text, DEFERRAL_MARKERS);
export const isObservable = (text: string): boolean =>
  /\d/.test(text) || containsAny(text, OBSERVABILITY_LEXICON);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-scoring.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add ts/reqs/constants.ts ts/reqs/scoring.ts ts/tests/reqs-scoring.test.ts
git commit -m "feat: deterministic scoring library — bands, zones, admissibility, lexicons"
```

---

## Task 3: The artefact schema

**Files:**
- Create: `ts/reqs/schema.ts`
- Test: `ts/tests/reqs-schema.test.ts`

**Interfaces:**
- Consumes: `Fib`, `Decision` from `scoring.js`.
- Produces: `ReqsBody` (zod) and `type ReqsBody`; `RequirementNode`, `type RequirementNodeT`; `AcceptanceCriterion`, `Grounding`, `Clarification`, `Residual`, `Signoff`, `Finding`, `type Finding`; `SEVERITIES`, `parseReqs(raw: unknown): { ok: true; body: ReqsBody } | { ok: false; issues: string[] }`.

**Critical:** three fields are deliberately loose so the gate owns the verdict — `signoff.result: z.string()`, `approver.kind: z.string()`, and `score.magnitude` accepts any Fib rather than the correct one. Tightening them turns a named refusal into a zod stack trace and breaks the demo.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/reqs-schema.test.ts
import { describe, expect, it } from "vitest";
import { parseReqs } from "../reqs/schema.js";
import { minimalBody } from "./helpers/reqs-fixture.js";

describe("reqs schema", () => {
  it("accepts a minimal valid body", () => {
    const r = parseReqs(minimalBody());
    expect(r.ok).toBe(true);
  });

  it("rejects a node id that does not extend its parent's pattern", () => {
    const b = minimalBody();
    (b.tree as any).id = "REQ-1";
    expect(parseReqs(b).ok).toBe(false);
  });

  it("accepts a wrong magnitude, so SCORE-001 owns that verdict not the schema", () => {
    const b = minimalBody();
    (b.tree as any).score.magnitude = 21;
    expect(parseReqs(b).ok).toBe(true);
  });

  it("accepts a forged approver kind, so GATE-006 owns that verdict", () => {
    const b = minimalBody();
    (b as any).signoff = {
      approvers: [{ name: "bot", role: "PO", kind: "agent", at: "2026-07-30T00:00:00Z" }],
      result: "partial",
    };
    expect(parseReqs(b).ok).toBe(true);
  });

  it("accepts result 'passed', so GATE-001 owns that verdict", () => {
    const b = minimalBody();
    (b as any).signoff = { approvers: [], result: "passed" };
    expect(parseReqs(b).ok).toBe(true);
  });

  it("requires at least one observable outcome on an acceptance criterion", () => {
    const b = minimalBody();
    (b.tree as any).acceptanceCriteria[0].then = [];
    expect(parseReqs(b).ok).toBe(false);
  });

  it("reports readable issue paths", () => {
    const r = parseReqs({ schemaVersion: "1.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toContain("metadata");
  });
});
```

Also create the shared fixture helper, used by Tasks 3–7:

```ts
// ts/tests/helpers/reqs-fixture.ts
/**
 * The smallest body that passes every check. Tests mutate a clone of it, so each
 * test states exactly one defect and nothing else.
 */
import type { ReqsBody } from "../../reqs/schema.js";

export function minimalBody(): ReqsBody {
  const at = "2026-07-30T00:00:00.000Z";
  return {
    schemaVersion: "1.0",
    metadata: {
      workItem: "PTR-401",
      title: "Intraday PSR limit amendment",
      deliveryType: { kind: "backend", tech: "legacy" },
      createdAt: at,
      updatedAt: at,
      executionProfile: { mode: "full" },
      generator: { agent: "copilot", model: null, version: "0.1.0" },
      corpusMode: "fixtures",
    },
    tree: {
      id: "REQ-ROOT",
      nodeKey: "limit-amendment.root",
      statement: "Risk Ops can amend a counterparty PSR limit intraday.",
      score: { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at },
      scoreHistory: [{ unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at }],
      decision: "leaf",
      isLeaf: true,
      acceptanceCriteria: [
        {
          id: "AC-1",
          stakeholder: "Risk Ops",
          given: "an approved amendment for CPTY-ALPHA",
          when: "credit-admin applies it",
          then: ["psr-cache reflects the new limit within 250ms"],
          observable: true,
        },
      ],
      grounding: [],
    },
    clarifications: [],
    residuals: [],
    traceability: { "AC-1": "REQ-ROOT" },
  } as ReqsBody;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-schema.test.ts`
Expected: FAIL — `Cannot find module '../reqs/schema.js'`

- [ ] **Step 3: Write the implementation**

```ts
// ts/reqs/schema.ts
/**
 * The canonical body. `.json` is for agents; markdown and HTML are pure
 * projections regenerated from this and therefore cannot drift.
 *
 * Fields marked [G] are generated by the assembler and recomputed by the
 * analyser — disagreement is a gate error, which is what makes the artefact
 * tamper-evident.
 */
import { z } from "zod";
import { FIB } from "./constants.js";

export const Fib = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
  z.literal(21),
]);

export const DECISIONS = ["leaf", "decompose", "clarify"] as const;
export const RESOLVED_FROM = [
  "context",
  "architecture",
  "project_docs",
  "knowledge_base",
  "human",
] as const;
export const SEVERITIES = ["error", "warning"] as const;

export const Finding = z.object({
  id: z.string(),
  severity: z.enum(SEVERITIES),
  path: z.string(),
  message: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const Grounding = z.object({
  source: z.string(),
  /** an EIL document id — "confluence:page:ptrd-2" — the seam into the knowledge plane */
  docId: z.string().min(1),
  title: z.string(),
  url: z.string().nullish(),
  /** must appear verbatim in the cited document; CLARIFY-005 enforces it */
  quote: z.string().min(1),
  retrievedAt: z.string(),
  traceId: z.string().nullish(),
  hedged: z.boolean().default(false), // [G]
});

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC-\d+$/),
  stakeholder: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.array(z.string().min(1)).min(1),
  observable: z.boolean().default(false), // [G]
});

export const ScorePass = z.object({
  unknowns: Fib,
  complexity: Fib,
  /** [G] — deliberately accepts a WRONG band so SCORE-001 owns the verdict */
  magnitude: Fib,
  decision: z.enum(DECISIONS),
  at: z.string(),
  note: z.string().optional(),
});

export interface RequirementNodeT {
  id: string;
  parentId?: string;
  nodeKey: string;
  statement: string;
  score: z.infer<typeof ScorePass>;
  scoreHistory: z.infer<typeof ScorePass>[];
  decision: (typeof DECISIONS)[number];
  isLeaf: boolean;
  children?: RequirementNodeT[];
  acceptanceCriteria?: z.infer<typeof AcceptanceCriterion>[];
  grounding: z.infer<typeof Grounding>[];
  resolvedFrom?: (typeof RESOLVED_FROM)[number];
  residualRef?: string;
}

export const RequirementNode: z.ZodType<RequirementNodeT> = z.lazy(() =>
  z.object({
    /** every child id extends its parent's: REQ-ROOT.1.2 */
    id: z.string().regex(/^REQ-ROOT(\.\d+)*$/),
    /** absent on the root — structural fields are absent, never empty */
    parentId: z.string().optional(),
    nodeKey: z.string().regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/),
    statement: z.string().min(1),
    score: ScorePass,
    scoreHistory: z.array(ScorePass).min(1),
    decision: z.enum(DECISIONS),
    isLeaf: z.boolean(), // [G]
    children: z.array(RequirementNode).optional(),
    acceptanceCriteria: z.array(AcceptanceCriterion).optional(),
    grounding: z.array(Grounding).default([]),
    resolvedFrom: z.enum(RESOLVED_FROM).optional(),
    residualRef: z.string().optional(),
  }),
);

export const Clarification = z.object({
  id: z.string().regex(/^CL-\d+$/),
  nodeId: z.string(),
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().regex(/^OPT-\d+$/),
        text: z.string().min(1),
        implication: z.string().min(1),
      }),
    )
    .default([]),
  answer: z
    .object({ chosenOptionId: z.string().optional(), freetext: z.string().optional() })
    .optional(),
  answeredBy: z
    .object({ kind: z.enum(["human", "knowledge_base"]), name: z.string().min(1) })
    .optional(),
  answeredAt: z.string().optional(),
  resultingDetail: z.string().optional(),
  resolvedFrom: z.enum(RESOLVED_FROM).optional(),
  grounding: z.array(Grounding).default([]),
});

export const Residual = z.object({
  id: z.string().regex(/^RU-\d+$/),
  kind: z.enum(["ResidualUncertainty", "ResidualRisk", "accepted_complexity"]),
  nodeId: z.string(),
  statement: z.string().min(1),
  mitigation: z.string().optional(),
  /** a residual is only carried on a named human's authority */
  acceptedBy: z.object({ kind: z.literal("human"), name: z.string().min(1) }),
  acceptedAt: z.string(),
});

export const Signoff = z.object({
  approvers: z
    .array(
      z.object({
        name: z.string().min(1),
        role: z.string(),
        /** deliberately loose — GATE-006 owns "must be human" */
        kind: z.string(),
        at: z.string(),
      }),
    )
    .default([]),
  /** deliberately loose — GATE-001 owns "passed is never admissible" */
  result: z.string(),
});

export const ReqsBody = z.object({
  schemaVersion: z.literal("1.0"),
  metadata: z.object({
    workItem: z.string().min(1),
    title: z.string().min(1),
    deliveryType: z.object({
      kind: z.enum(["ui", "backend", "migration", "mixed"]),
      tech: z.enum(["new", "legacy"]),
    }),
    createdAt: z.string(),
    /** the staleness pin downstream phases record and compare */
    updatedAt: z.string(),
    executionProfile: z.object({ mode: z.enum(["full", "fast"]) }).default({ mode: "full" }),
    generator: z.object({
      agent: z.string(),
      model: z.string().nullish(),
      version: z.string(),
    }),
    /** stamped so no run can be misrepresented as the other */
    corpusMode: z.enum(["fixtures", "live"]),
  }),
  tree: RequirementNode,
  clarifications: z.array(Clarification).default([]),
  residuals: z.array(Residual).default([]),
  /** [G] AC id -> node id */
  traceability: z.record(z.string(), z.string()).default({}),
  /** [G] */
  coverage: z
    .object({
      leaves: z.number(),
      acs: z.number(),
      unknownsTotal: z.number(),
      grounded: z.number(),
      escalated: z.number(),
      carried: z.number(),
    })
    .optional(),
  signoff: Signoff.optional(),
  /** written by the analyser, never by the model */
  analysis: z
    .object({ ranAt: z.string(), checksRun: z.number(), findings: z.array(Finding) })
    .optional(),
});
export type ReqsBody = z.infer<typeof ReqsBody>;

export function parseReqs(
  raw: unknown,
): { ok: true; body: ReqsBody } | { ok: false; issues: string[] } {
  const r = ReqsBody.safeParse(raw);
  if (r.success) return { ok: true, body: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/** Depth-first walk, parents before children, with depth starting at 1. */
export function* walk(
  node: RequirementNodeT,
  depth = 1,
): Generator<{ node: RequirementNodeT; depth: number; path: string }> {
  yield { node, depth, path: node.id };
  for (const c of node.children ?? []) yield* walk(c, depth + 1);
}
```

Note `FIB` is imported but unused in `schema.ts` — remove that import; biome will flag it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-schema.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add ts/reqs/schema.ts ts/tests/reqs-schema.test.ts ts/tests/helpers/reqs-fixture.ts
git commit -m "feat: reqs.json schema — loose exactly where the gate is strict"
```

---

## Task 4: The assembler

**Files:**
- Create: `ts/reqs/assemble.ts`
- Test: `ts/tests/reqs-assemble.test.ts`

**Interfaces:**
- Consumes: `ReqsBody`, `RequirementNodeT`, `walk` from `schema.js`; `magnitude`, `hasHedge`, `isObservable` from `scoring.js`.
- Produces: `assemble(body: ReqsBody): ReqsBody` — returns a new body with every `[G]` field recomputed; `nextAcId(body: ReqsBody): string`.

`assemble` is the only writer of generated fields. The analyser calls it and compares, which is how `META-002` detects a hand-authored generated field.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/reqs-assemble.test.ts
import { describe, expect, it } from "vitest";
import { assemble, nextAcId } from "../reqs/assemble.js";
import { clone, minimalBody } from "./helpers/reqs-fixture.js";

describe("assemble", () => {
  it("recomputes magnitude from the bands, overwriting whatever was authored", () => {
    const b = clone(minimalBody());
    (b.tree as any).score.magnitude = 21;
    expect(assemble(b).tree.score.magnitude).toBe(2);
  });

  it("derives isLeaf from the decision", () => {
    const b = clone(minimalBody());
    (b.tree as any).isLeaf = false;
    expect(assemble(b).tree.isLeaf).toBe(true);
  });

  it("marks a hedged quote so the artefact cannot inherit false confidence", () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "There's a staleness cutoff, I think 5s",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: false,
      },
    ];
    expect(assemble(b).tree.grounding[0]!.hedged).toBe(true);
  });

  it("inverts the tree into a traceability index rather than trusting an authored one", () => {
    const b = clone(minimalBody());
    b.traceability = { "AC-99": "REQ-NOWHERE" };
    expect(assemble(b).traceability).toEqual({ "AC-1": "REQ-ROOT" });
  });

  it("counts coverage from the tree and the ledgers", () => {
    const b = clone(minimalBody());
    const out = assemble(b);
    expect(out.coverage).toEqual({
      leaves: 1,
      acs: 1,
      unknownsTotal: 1,
      grounded: 0,
      escalated: 0,
      carried: 0,
    });
  });

  it("allocates the next AC id monotonically above the highest ever used", () => {
    const b = clone(minimalBody());
    b.tree.acceptanceCriteria!.push({
      id: "AC-7",
      stakeholder: "QA",
      given: "g",
      when: "w",
      then: ["rejects with code 4001"],
      observable: true,
    });
    expect(nextAcId(b)).toBe("AC-8");
  });

  it("is idempotent — assembling twice changes nothing", () => {
    const once = assemble(clone(minimalBody()));
    expect(assemble(clone(once))).toEqual(once);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-assemble.test.ts`
Expected: FAIL — `Cannot find module '../reqs/assemble.js'`

- [ ] **Step 3: Write the implementation**

```ts
// ts/reqs/assemble.ts
/**
 * Derived fields are generated, never authored. This module is their only
 * writer; the analyser calls it and compares, so a hand-edited generated field
 * is a gate error (META-002) rather than a silent lie.
 */
import type { ReqsBody, RequirementNodeT } from "./schema.js";
import { walk } from "./schema.js";
import { hasHedge, isObservable, magnitude } from "./scoring.js";

function assembleNode(node: RequirementNodeT): RequirementNodeT {
  return {
    ...node,
    score: { ...node.score, magnitude: magnitude(node.score.unknowns, node.score.complexity) },
    scoreHistory: node.scoreHistory.map((p) => ({
      ...p,
      magnitude: magnitude(p.unknowns, p.complexity),
    })),
    isLeaf: node.decision === "leaf",
    grounding: node.grounding.map((g) => ({ ...g, hedged: hasHedge(g.quote) })),
    acceptanceCriteria: node.acceptanceCriteria?.map((ac) => ({
      ...ac,
      observable: ac.then.every((t) => isObservable(t)),
    })),
    children: node.children?.map(assembleNode),
  };
}

export function assemble(body: ReqsBody): ReqsBody {
  const tree = assembleNode(body.tree);

  // The traceability index is INVERTED from the tree, never maintained by hand,
  // so a coverage index structurally cannot disagree with what it indexes.
  const traceability: Record<string, string> = {};
  let leaves = 0;
  let acs = 0;
  let unknownsTotal = 0;
  for (const { node } of walk(tree)) {
    unknownsTotal += 1;
    if (node.isLeaf) leaves += 1;
    for (const ac of node.acceptanceCriteria ?? []) {
      traceability[ac.id] = node.id;
      acs += 1;
    }
  }

  const grounded = body.clarifications.filter(
    (c) => c.answeredBy?.kind === "knowledge_base" && c.grounding.length > 0,
  ).length;
  const escalated = body.clarifications.filter(
    (c) => c.answeredBy?.kind === "human" || c.answeredBy === undefined,
  ).length;

  return {
    ...body,
    tree,
    traceability,
    coverage: { leaves, acs, unknownsTotal, grounded, escalated, carried: body.residuals.length },
    clarifications: body.clarifications.map((c) => ({
      ...c,
      grounding: c.grounding.map((g) => ({ ...g, hedged: hasHedge(g.quote) })),
    })),
  };
}

/** Ids are allocated monotonically above the highest ever used; retired ids are
 *  never reissued, so a traceability reference can never silently remap. */
export function nextAcId(body: ReqsBody): string {
  let max = 0;
  for (const { node } of walk(body.tree))
    for (const ac of node.acceptanceCriteria ?? [])
      max = Math.max(max, Number(ac.id.slice(3)) || 0);
  return `AC-${max + 1}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-assemble.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add ts/reqs/assemble.ts ts/tests/reqs-assemble.test.ts
git commit -m "feat: assembler — every derived field generated, traceability inverted from the tree"
```

---

## Task 5: The renderer

Built before the analyser deliberately: it makes everything else visible, so there is a demoable artefact even if later tasks are cut.

**Files:**
- Create: `ts/reqs/render.ts`
- Test: extend `ts/tests/reqs-assemble.test.ts` with a `render` describe block (avoids a new file for two assertions).

**Interfaces:**
- Consumes: `ReqsBody`, `Finding` from `schema.js`; `walk` from `schema.js`.
- Produces: `renderMarkdown(body: ReqsBody): string`, `renderHtml(body: ReqsBody, findings?: Finding[]): string`.

**Requirements:**
- Self-contained HTML: inline `<style>`, no external assets, no JS, no fetch. Matches the existing `docs/*.html` house style — dark-first with a `prefers-color-scheme: light` variant, monospace.
- When `findings` contains any `severity: "error"`, the page renders a `REFUSED` banner listing each finding's id, path and message. This is what the room sees during the tamper beat.
- Renders: metadata header with `corpusMode` visible; the requirement tree as a nested list showing `id`, statement, `U×C→M`, decision; acceptance criteria as GIVEN/WHEN/THEN; a **grounding table** with doc id, title, quote and a `hedged` marker; the clarification ledger split into grounded and escalated; residuals with their named acceptor; and the sign-off block.
- Pure: same body in, same string out. No timestamps generated at render time — read them from the body.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/reqs-assemble.test.ts
import { renderHtml, renderMarkdown } from "../reqs/render.js";

describe("render", () => {
  it("is a pure projection — same body in, same string out", () => {
    const b = assemble(clone(minimalBody()));
    expect(renderHtml(b)).toBe(renderHtml(clone(b)));
  });

  it("stamps REFUSED when any finding is an error", () => {
    const b = assemble(clone(minimalBody()));
    const html = renderHtml(b, [
      { id: "SCORE-001", severity: "error", path: "tree.score", message: "stored 21, recomputed 2" },
    ]);
    expect(html).toContain("REFUSED");
    expect(html).toContain("SCORE-001");
  });

  it("does not stamp REFUSED for warnings alone", () => {
    const b = assemble(clone(minimalBody()));
    const html = renderHtml(b, [
      { id: "AC-005", severity: "warning", path: "tree.acceptanceCriteria.0", message: "not observable" },
    ]);
    expect(html).not.toContain("REFUSED");
  });

  it("shows the corpus mode so a run cannot be misrepresented", () => {
    const b = assemble(clone(minimalBody()));
    expect(renderMarkdown(b)).toContain("fixtures");
  });

  it("embeds no external references", () => {
    const html = renderHtml(assemble(clone(minimalBody())));
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toContain("<script");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-assemble.test.ts`
Expected: FAIL — `Cannot find module '../reqs/render.js'`

- [ ] **Step 3: Write `ts/reqs/render.ts`**

Implement `renderMarkdown` and `renderHtml` to the requirements above. Escape all interpolated text with a local `esc()` (`&`, `<`, `>`, `"`), since quotes come from arbitrary source documents. Use `walk()` for the tree. Keep the whole module under ~250 lines; if it grows past that, the style block is doing too much.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-assemble.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Eyeball the output**

```bash
pnpm tsx -e "import{assemble}from'./ts/reqs/assemble.js';import{renderHtml}from'./ts/reqs/render.js';import{minimalBody}from'./ts/tests/helpers/reqs-fixture.js';import{writeFileSync}from'node:fs';writeFileSync('/tmp/reqs.html',renderHtml(assemble(minimalBody())))"
open /tmp/reqs.html
```

Expected: readable, dark, no missing styles. This is projected on a screen tomorrow — it has to look deliberate.

- [ ] **Step 6: Commit**

```bash
git add ts/reqs/render.ts ts/tests/reqs-assemble.test.ts
git commit -m "feat: reqs renderer — pure projection, REFUSED banner on any error finding"
```

---

## Task 6: The analyser — runner plus structural and scoring checks

**Files:**
- Create: `ts/reqs/analyse.ts`, `ts/reqs/checks/structural.ts`, `ts/reqs/checks/scoring.ts`
- Test: `ts/tests/reqs-analyse.test.ts`

**Interfaces:**
- Consumes: `ReqsBody`, `Finding`, `walk`, `parseReqs` from `schema.js`; `assemble` from `assemble.js`; `scoring.js`; `REGISTERED_CONSTANTS`.
- Produces:
  - `type Check = { id: string; severity: "error" | "warning"; run(ctx: CheckContext): Finding[] }`
  - `interface CheckContext { body: ReqsBody; assembled: ReqsBody; resolveDoc?: (docId: string) => Promise<string | null> }`
  - `analyse(body: ReqsBody, opts?: { mode?: "exit" | "lint"; resolveDoc?: ... }): Promise<{ findings: Finding[]; checksRun: number; ok: boolean }>`
  - `STRUCTURAL_CHECKS: Check[]`, `SCORING_CHECKS: Check[]`

**Design note — dependency injection:** `resolveDoc` is injected rather than imported so the analyser stays a pure unit under test with no database. When it is absent, `CLARIFY-005` emits nothing and `checksRun` excludes it. The CLI supplies the real resolver.

**Mode semantics:** `mode: "exit"` (default) is the gate — `ok` is false if any finding has `severity: "error"`. `mode: "lint"` downgrades the GATE family to warnings for mid-loop use; it downgrades **nothing else**.

### Checks in this task — 16

| id | sev | Fires when |
|---|---|---|
| `SCHEMA-001` | error | `parseReqs` fails; one finding per zod issue, `path` = the issue path |
| `SCHEMA-002` | error | a non-root node id is not `` `${parentId}.${n}` `` for some positive integer n |
| `SCHEMA-003` | error | the root carries `parentId`, or a non-root omits it, or `parentId` names a node that is not its actual parent |
| `SCHEMA-004` | error | `decision === "leaf"` and `children` is present, or `decision !== "leaf"` and `acceptanceCriteria` is present |
| `SCHEMA-005` | error | `decision` or a `scoreHistory[].decision` is not in `DECISIONS` (reachable when the body is loaded unvalidated) |
| `TREE-001` | error | `decision` is not in `decisionSpace(score.unknowns, score.complexity)` |
| `TREE-002` | error | `decision === "decompose"` and `(children ?? []).length < 2` |
| `TREE-003` | error | a node's depth exceeds `maxDepth` |
| `TREE-004` | error | a node at depth `maxDepth` has `decision !== "leaf"` and has neither a clarification referencing it nor a `residualRef` |
| `TREE-005` | error | two nodes share a `nodeKey` |
| `TREE-006` | **warning** | every leaf sits at the same depth and there is more than one leaf — the uniform-depth signature of a pre-drawn tree rather than genuine discovery |
| `SCORE-001` | error | `score.magnitude !== magnitude(score.unknowns, score.complexity)`, or the same for any `scoreHistory` entry |
| `SCORE-002` | error | `score.unknowns` or `score.complexity` is not a Fibonacci band |
| `SCORE-003` | error | `score` is not deep-equal to the last `scoreHistory` entry |
| `SCORE-005` | error | `scoreHistory` timestamps are not non-decreasing |
| `SCORE-006` | error | a node whose history contains a `clarify` pass and whose final `decision === "leaf"` does not have final `unknowns` strictly less than the `unknowns` of its last `clarify` pass |
| `UNCERT-001` | error | `zone(magnitude) === "review"` and `decision === "leaf"` and `residualRef` is absent or names no existing residual |
| `UNCERT-002` | error | a residual's `acceptedBy.name` is empty, or `acceptedBy.kind !== "human"` |
| `UNCERT-005` | error | consecutive `scoreHistory` passes where `unknowns` did not fall, `unknowns >= clarifyUnknownsFloor`, and the later pass's `decision === "decompose"` — blind decomposition of an inherent unknown |

That is 19 with UNCERT; UNCERT lives in `checks/scoring.ts` alongside SCORE because both reason over score history.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/reqs-analyse.test.ts
import { describe, expect, it } from "vitest";
import { analyse } from "../reqs/analyse.js";
import { clone, minimalBody } from "./helpers/reqs-fixture.js";

const ids = async (b: unknown) => (await analyse(b as any)).findings.map((f) => f.id);

describe("analyse — clean body", () => {
  it("passes the minimal body with no errors", async () => {
    const r = await analyse(clone(minimalBody()));
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("reports how many checks ran", async () => {
    expect((await analyse(clone(minimalBody()))).checksRun).toBeGreaterThan(15);
  });
});

describe("SCORE-001 — the model's arithmetic is never trusted", () => {
  it("refuses a stored magnitude that disagrees with the recompute", async () => {
    const b = clone(minimalBody());
    (b.tree as any).score.magnitude = 21;
    expect(await ids(b)).toContain("SCORE-001");
    expect((await analyse(b)).ok).toBe(false);
  });
});

describe("TREE-001 — inadmissible decisions", () => {
  it("refuses a leaf at or above the decompose threshold", async () => {
    const b = clone(minimalBody());
    (b.tree as any).score = { unknowns: 8, complexity: 8, magnitude: 8, decision: "leaf", at: "2026-07-30T00:00:00.000Z" };
    (b.tree as any).scoreHistory = [b.tree.score];
    expect(await ids(b)).toContain("TREE-001");
  });
});

describe("TREE-002", () => {
  it("refuses a decompose with a single child", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).score = { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at };
    (b.tree as any).scoreHistory = [b.tree.score];
    (b.tree as any).decision = "decompose";
    (b.tree as any).isLeaf = false;
    delete (b.tree as any).acceptanceCriteria;
    (b.tree as any).children = [
      { ...clone(minimalBody().tree), id: "REQ-ROOT.1", parentId: "REQ-ROOT", nodeKey: "a.b" },
    ];
    expect(await ids(b)).toContain("TREE-002");
  });
});

describe("SCORE-006 — a clarification must actually reduce uncertainty", () => {
  it("refuses clarify -> leaf where the unknowns did not fall", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).scoreHistory = [
      { unknowns: 8, complexity: 2, magnitude: 8, decision: "clarify", at },
      { unknowns: 8, complexity: 2, magnitude: 8, decision: "leaf", at: "2026-07-30T01:00:00.000Z" },
    ];
    (b.tree as any).score = b.tree.scoreHistory[1];
    expect(await ids(b)).toContain("SCORE-006");
  });
});

describe("UNCERT-001 — the review zone needs an accepted residual", () => {
  it("refuses a review-zone leaf with no residual reference", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).score = { unknowns: 3, complexity: 3, magnitude: 3, decision: "leaf", at };
    (b.tree as any).scoreHistory = [b.tree.score];
    expect(await ids(b)).toContain("UNCERT-001");
  });
});

describe("TREE-006 — the pre-drawn-tree signature is advisory, not fatal", () => {
  it("warns on uniform depth without blocking", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).score = { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at };
    (b.tree as any).scoreHistory = [b.tree.score];
    (b.tree as any).decision = "decompose";
    (b.tree as any).isLeaf = false;
    delete (b.tree as any).acceptanceCriteria;
    (b.tree as any).children = [1, 2].map((n) => ({
      ...clone(minimalBody().tree),
      id: `REQ-ROOT.${n}`,
      parentId: "REQ-ROOT",
      nodeKey: `child.${n}`,
      acceptanceCriteria: [
        { id: `AC-${n}`, stakeholder: "QA", given: "g", when: "w", then: ["rejects with code 4001"], observable: true },
      ],
    }));
    const r = await analyse(b as any);
    expect(r.findings.find((f) => f.id === "TREE-006")?.severity).toBe("warning");
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts`
Expected: FAIL — `Cannot find module '../reqs/analyse.js'`

- [ ] **Step 3: Write the runner**

```ts
// ts/reqs/analyse.ts
/**
 * The gate. Every check is a small pure function over the typed body, with an
 * enumerated id and a severity, so a refusal names itself. The analyser imports
 * `scoring` and `assemble` rather than re-deriving anything, so scorer and
 * checker cannot disagree.
 *
 * `mode: "exit"` is the gate — any error-severity finding blocks emission.
 * `mode: "lint"` downgrades ONLY the GATE family, for mid-loop use.
 */
import { assemble } from "./assemble.js";
import type { Finding, ReqsBody } from "./schema.js";
import { parseReqs } from "./schema.js";
import { SCORING_CHECKS } from "./checks/scoring.js";
import { STRUCTURAL_CHECKS } from "./checks/structural.js";

export interface CheckContext {
  body: ReqsBody;
  /** the same body with every generated field recomputed */
  assembled: ReqsBody;
  /** injected, so the analyser is unit-testable with no database */
  resolveDoc?: (docId: string) => Promise<string | null>;
}

export interface Check {
  id: string;
  severity: "error" | "warning";
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

export interface AnalyseResult {
  findings: Finding[];
  checksRun: number;
  ok: boolean;
}

export function allChecks(): Check[] {
  return [...STRUCTURAL_CHECKS, ...SCORING_CHECKS];
}

export async function analyse(
  raw: unknown,
  opts: { mode?: "exit" | "lint"; resolveDoc?: (docId: string) => Promise<string | null> } = {},
): Promise<AnalyseResult> {
  const mode = opts.mode ?? "exit";
  const parsed = parseReqs(raw);
  if (!parsed.ok) {
    return {
      findings: parsed.issues.map((msg) => ({
        id: "SCHEMA-001",
        severity: "error" as const,
        path: msg.split(":")[0]!,
        message: msg,
      })),
      checksRun: 1,
      ok: false,
    };
  }

  const ctx: CheckContext = {
    body: parsed.body,
    assembled: assemble(parsed.body),
    resolveDoc: opts.resolveDoc,
  };

  const checks = allChecks().filter((c) => c.id !== "CLARIFY-005" || ctx.resolveDoc);
  const findings: Finding[] = [];
  for (const c of checks) findings.push(...(await c.run(ctx)));

  const effective =
    mode === "lint"
      ? findings.map((f) => (f.id.startsWith("GATE-") ? { ...f, severity: "warning" as const } : f))
      : findings;

  return {
    findings: effective,
    checksRun: checks.length,
    ok: !effective.some((f) => f.severity === "error"),
  };
}
```

- [ ] **Step 4: Write `ts/reqs/checks/structural.ts` and `ts/reqs/checks/scoring.ts`**

Implement every check in the table above, each as a `Check` object. Pattern to follow for all of them:

```ts
// ts/reqs/checks/scoring.ts — the shape every check takes
import type { Check } from "../analyse.js";
import type { Finding } from "../schema.js";
import { walk } from "../schema.js";
import { magnitude, isFib, zone } from "../scoring.js";
import { REGISTERED_CONSTANTS as K } from "../constants.js";

const SCORE_001: Check = {
  id: "SCORE-001",
  severity: "error",
  run({ body }) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      const want = magnitude(node.score.unknowns, node.score.complexity);
      if (node.score.magnitude !== want)
        out.push({
          id: "SCORE-001",
          severity: "error",
          path: `${path}.score.magnitude`,
          message: `stored magnitude ${node.score.magnitude}, recomputed ${want} from U=${node.score.unknowns} C=${node.score.complexity}`,
        });
      node.scoreHistory.forEach((p, i) => {
        const w = magnitude(p.unknowns, p.complexity);
        if (p.magnitude !== w)
          out.push({
            id: "SCORE-001",
            severity: "error",
            path: `${path}.scoreHistory.${i}.magnitude`,
            message: `stored magnitude ${p.magnitude}, recomputed ${w}`,
          });
      });
    }
    return out;
  },
};

const UNCERT_001: Check = {
  id: "UNCERT-001",
  severity: "error",
  run({ body }) {
    const out: Finding[] = [];
    const residualIds = new Set(body.residuals.map((r) => r.id));
    for (const { node, path } of walk(body.tree)) {
      const m = magnitude(node.score.unknowns, node.score.complexity);
      if (zone(m) !== "review" || node.decision !== "leaf") continue;
      if (!node.residualRef || !residualIds.has(node.residualRef))
        out.push({
          id: "UNCERT-001",
          severity: "error",
          path: `${path}.residualRef`,
          message: `a review-zone leaf (M=${m}) must reference an accepted residual; found ${node.residualRef ?? "none"}`,
        });
    }
    return out;
  },
};

export const SCORING_CHECKS: Check[] = [SCORE_001, /* SCORE_002, 003, 005, 006, */ UNCERT_001 /* , UNCERT_002, UNCERT_005 */];
```

Every message must state the observed value and the expected value. A refusal read aloud on stage has to be self-explanatory.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add ts/reqs/analyse.ts ts/reqs/checks ts/tests/reqs-analyse.test.ts
git commit -m "feat: analyser runner + 19 structural and scoring checks"
```

---

## Task 7: The analyser — content, provenance and gate checks

**Files:**
- Create: `ts/reqs/checks/content.ts`, `ts/reqs/checks/provenance.ts`
- Modify: `ts/reqs/analyse.ts:allChecks` to include both
- Test: extend `ts/tests/reqs-analyse.test.ts`

**Interfaces:**
- Consumes: `Check`, `CheckContext` from `analyse.js`.
- Produces: `CONTENT_CHECKS: Check[]`, `PROVENANCE_CHECKS: Check[]`.

### Checks in this task — 23

| id | sev | Fires when |
|---|---|---|
| `AC-001` | error | `decision === "leaf"` and `(acceptanceCriteria ?? []).length === 0` |
| `AC-002` | error | an AC has an empty `given`, `when`, or `then` |
| `AC-003` | error | an AC's `then` array is empty |
| `AC-004` | error | an AC id appears on more than one node, or does not match `/^AC-\d+$/` |
| `AC-005` | **warning** | `isObservable()` is false for any `then` entry |
| `AC-006` | error | an AC has an empty `stakeholder` |
| `DEFER-001` | error | a deferral marker appears in an **authored prose field**. The scanned set is exactly: `metadata.title`, every node's `statement`, every `score.rationale`/`note`, every AC's `given`/`when`/`then[]`, every clarification's `question`/`options[].text`/`options[].implication`/`resultingDetail`, every residual's `statement`/`mitigation`. **`grounding[].quote` is NOT scanned** — quotes are verbatim and may legitimately contain someone else's TODO; `CLARIFY-006` covers that case |
| `DEFER-002` | error | a deferral marker appears in `resultingDetail` or in a residual `mitigation` — the recorded-decision fields specifically |
| `CLARIFY-001` | error | a node whose `scoreHistory` contains a `clarify` pass has no clarification with `nodeId === node.id` |
| `CLARIFY-002` | error | a clarification has no `answer`, or an `answer` with neither `chosenOptionId` nor `freetext` |
| `CLARIFY-003` | error | `answeredBy.kind === "knowledge_base"` and `grounding.length === 0` |
| `CLARIFY-004` | error | an option has an empty `implication` |
| `CLARIFY-005` | error | **a `quote` is not found verbatim in the document it cites.** Requires `resolveDoc`; skipped entirely when absent. Compare after normalising runs of whitespace to a single space on both sides, and nothing else — no case folding, no punctuation stripping |
| `CLARIFY-006` | **warning** | `hasHedge(quote)` is true and no residual has `nodeId` equal to the node carrying that grounding |
| `TRACE-001` | error | an AC in the tree is absent from `body.traceability`, or maps to the wrong node id |
| `TRACE-002` | error | `body.traceability` names a node id that does not exist in the tree |
| `TRACE-007` | error | reserved for refinement under a baseline. Register the check, return `[]` unconditionally, and comment that the baseline path is out of scope for phase 1 |
| `GATE-001` | error | `signoff` exists and `signoff.result` is not `"partial"` or `"failed"` |
| `GATE-002` | error | `signoff` exists and `body.analysis?.findings` contains any `severity: "error"` |
| `GATE-003` | error | `signoff` exists and the approver roles do not cover all of `PO`, `TechLead`, `QA` |
| `GATE-006` | error | any approver has `kind !== "human"` |
| `META-001` | error | `metadata.updatedAt` is absent, or is not parseable by `Date.parse`, or is earlier than `metadata.createdAt` |
| `META-002` | error | any generated field in `body` differs from the same field in `ctx.assembled`. Compare `tree` (via a walk over `score.magnitude`, `isLeaf`, `grounding[].hedged`, `acceptanceCriteria[].observable`), `traceability`, and `coverage`. One finding per differing path |

`META-001`/`META-002` belong in `checks/structural.ts` from Task 6; if Task 6 left them out, add them here.

- [ ] **Step 1: Write the failing tests**

```ts
// append to ts/tests/reqs-analyse.test.ts
describe("CLARIFY-005 — a citation cannot be fabricated", () => {
  const grounded = () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "PSR check itself is meant to stay under about 40us",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: false,
      },
    ];
    return b;
  };
  const doc = async () =>
    "Order path is tight. PSR check itself is meant to stay under about 40us, which is why it reads the local snapshot.";

  it("accepts a quote that is verbatim in the cited document", async () => {
    const r = await analyse(grounded(), { resolveDoc: doc });
    expect(r.findings.map((f) => f.id)).not.toContain("CLARIFY-005");
  });

  it("refuses a quote altered by a single word", async () => {
    const b = grounded();
    b.tree.grounding[0]!.quote = "PSR check itself is meant to stay under about 40ms";
    const r = await analyse(b, { resolveDoc: doc });
    expect(r.findings.map((f) => f.id)).toContain("CLARIFY-005");
    expect(r.ok).toBe(false);
  });

  it("refuses a citation whose document cannot be resolved at all", async () => {
    const r = await analyse(grounded(), { resolveDoc: async () => null });
    expect(r.findings.map((f) => f.id)).toContain("CLARIFY-005");
  });

  it("is skipped, not silently passed, when no resolver is injected", async () => {
    const withResolver = await analyse(grounded(), { resolveDoc: doc });
    const without = await analyse(grounded());
    expect(without.checksRun).toBe(withResolver.checksRun - 1);
  });
});

describe("CLARIFY-006 — a hedged source must not be laundered into a fact", () => {
  it("warns when a hedged quote carries no residual", async () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "There's a staleness cutoff, I think 5s",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: true,
      },
    ];
    const r = await analyse(b);
    expect(r.findings.find((f) => f.id === "CLARIFY-006")?.severity).toBe("warning");
  });
});

describe("GATE — the AI cannot sign its own homework", () => {
  const signed = (kind: string, result = "partial") => {
    const b = clone(minimalBody());
    (b as any).signoff = {
      approvers: [
        { name: "d.mercer", role: "PO", kind, at: "2026-07-30T02:00:00.000Z" },
        { name: "s.iyer", role: "TechLead", kind, at: "2026-07-30T02:00:00.000Z" },
        { name: "n.okafor", role: "QA", kind, at: "2026-07-30T02:00:00.000Z" },
      ],
      result,
    };
    return b;
  };

  it("accepts a human sign-off with all three roles", async () => {
    expect((await analyse(signed("human"))).ok).toBe(true);
  });
  it("refuses an agent as approver", async () => {
    const r = await analyse(signed("agent"));
    expect(r.findings.map((f) => f.id)).toContain("GATE-006");
    expect(r.ok).toBe(false);
  });
  it("refuses a self-issued pass", async () => {
    expect((await analyse(signed("human", "passed"))).findings.map((f) => f.id)).toContain("GATE-001");
  });
  it("refuses a sign-off missing a required role", async () => {
    const b = signed("human");
    (b as any).signoff.approvers.pop();
    expect((await analyse(b)).findings.map((f) => f.id)).toContain("GATE-003");
  });
});

describe("DEFER-001 — 'decide later' is not a completion state", () => {
  it("refuses a deferral marker in an authored statement", async () => {
    const b = clone(minimalBody());
    b.tree.statement = "Risk Ops can amend a limit intraday. Effective timing TBD.";
    expect((await analyse(b)).findings.map((f) => f.id)).toContain("DEFER-001");
  });

  it("does NOT fire on a verbatim quote that contains someone else's TODO", async () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "TODO: document the add-on factor refresh properly",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: false,
      },
    ];
    expect((await analyse(b)).findings.map((f) => f.id)).not.toContain("DEFER-001");
  });
});

describe("META-002 — derived fields are generated, never authored", () => {
  it("refuses a hand-edited traceability index", async () => {
    const b = clone(minimalBody());
    b.traceability = {};
    const r = await analyse(b);
    expect(r.findings.map((f) => f.id)).toContain("META-002");
    expect(r.findings.map((f) => f.id)).toContain("TRACE-001");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts`
Expected: FAIL — the new `describe` blocks fail; the Task 6 blocks still pass.

- [ ] **Step 3: Implement `content.ts` and `provenance.ts`, and register them**

Follow the `Check` shape from Task 6. `CLARIFY-005` specifically:

```ts
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

const CLARIFY_005: Check = {
  id: "CLARIFY-005",
  severity: "error",
  async run({ body, resolveDoc }) {
    if (!resolveDoc) return [];
    const out: Finding[] = [];
    const cited: { path: string; docId: string; quote: string }[] = [];
    for (const { node, path } of walk(body.tree))
      node.grounding.forEach((g, i) =>
        cited.push({ path: `${path}.grounding.${i}`, docId: g.docId, quote: g.quote }),
      );
    body.clarifications.forEach((c, ci) =>
      c.grounding.forEach((g, i) =>
        cited.push({ path: `clarifications.${ci}.grounding.${i}`, docId: g.docId, quote: g.quote }),
      ),
    );
    // one fetch per distinct document, not one per citation
    const docs = new Map<string, string | null>();
    for (const c of cited)
      if (!docs.has(c.docId)) docs.set(c.docId, await resolveDoc(c.docId));
    for (const c of cited) {
      const text = docs.get(c.docId);
      if (text === null || text === undefined) {
        out.push({
          id: "CLARIFY-005",
          severity: "error",
          path: `${c.path}.docId`,
          message: `cited document ${c.docId} could not be resolved, so the quote cannot be verified`,
        });
        continue;
      }
      if (!normalise(text).includes(normalise(c.quote)))
        out.push({
          id: "CLARIFY-005",
          severity: "error",
          path: `${c.path}.quote`,
          message: `quote is not present verbatim in ${c.docId}: ${JSON.stringify(c.quote.slice(0, 80))}`,
        });
    }
    return out;
  },
};
```

Update `allChecks()` in `ts/reqs/analyse.ts`:

```ts
import { CONTENT_CHECKS } from "./checks/content.js";
import { PROVENANCE_CHECKS } from "./checks/provenance.js";

export function allChecks(): Check[] {
  return [...STRUCTURAL_CHECKS, ...SCORING_CHECKS, ...CONTENT_CHECKS, ...PROVENANCE_CHECKS];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts`
Expected: PASS, all blocks.

- [ ] **Step 5: Assert the catalogue is complete and has no duplicate ids**

```ts
// append to ts/tests/reqs-analyse.test.ts
import { allChecks } from "../reqs/analyse.js";

describe("the catalogue", () => {
  it("registers 42 checks across 10 families with no duplicate ids", () => {
    const all = allChecks();
    expect(all).toHaveLength(42);
    expect(new Set(all.map((c) => c.id)).size).toBe(42);
    const families = new Set(all.map((c) => c.id.split("-")[0]));
    expect(families).toEqual(
      new Set(["SCHEMA", "SCORE", "TREE", "AC", "CLARIFY", "UNCERT", "DEFER", "TRACE", "GATE", "META"]),
    );
  });
});
```

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts`
Expected: PASS. If the count is not 42, a check from the spec's §7 table is missing — add it rather than changing the number.

- [ ] **Step 6: Full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. Pre-existing failures in `ts/tests/step3.test.ts` (missing `@huggingface/transformers`) are unrelated — note them, do not fix them here.

- [ ] **Step 7: Commit**

```bash
git add ts/reqs/checks ts/reqs/analyse.ts ts/tests/reqs-analyse.test.ts
git commit -m "feat: 42-check analyser complete — verbatim citation verification, human-only sign-off"
```

---

## Task 8: CLI — `eil reqs check` and `eil reqs render`

**CHECKPOINT.** After this task the centrepiece works: a real artefact, a real refusal, a real projection. Stop and assess the clock before Task 9.

**Files:**
- Modify: `ts/cli.ts` — add a `reqs` command group
- Create: `ts/reqs/io.ts` — load/save, and the real `resolveDoc`
- Test: extend `ts/tests/reqs-analyse.test.ts`

**Interfaces:**
- Consumes: `analyse`, `renderHtml`, `renderMarkdown`, `assemble`, `parseReqs`.
- Produces: `loadReqs(path: string): Promise<ReqsBody>`, `saveReqs(path: string, body: ReqsBody): Promise<void>`, `makeDocResolver(client: Db, viewer: Viewer): (docId: string) => Promise<string | null>`.

`makeDocResolver` must go through `callTool("get_doc", { id }, viewer)` — **not** a raw SQL read — so citation verification inherits the ACL viewer and lands an audited row. A citation to a document the viewer cannot see must fail `CLARIFY-005`, not silently verify.

Commands:

| Command | Behaviour |
|---|---|
| `eil reqs check <file>` | `--mode exit\|lint` (default `exit`), `--json`. Runs the analyser with a live `resolveDoc`. Prints `id  severity  path  message` one per line, then a summary. **Exit code 1 when `ok` is false**, 0 otherwise. |
| `eil reqs render <file>` | `--out <path>` (default alongside the input as `.html`), `--markdown`. Runs the analyser first and passes findings in, so a refused artefact renders stamped `REFUSED`. |

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/reqs-analyse.test.ts
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

describe("eil reqs check — exit codes are the gate", () => {
  const write = (body: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "reqs-")), "reqs.json");
    writeFileSync(p, JSON.stringify(body, null, 2));
    return p;
  };

  it("exits 0 on a clean artefact", async () => {
    const { stdout } = await run("pnpm", ["-s", "eil", "reqs", "check", write(minimalBody())]);
    expect(stdout).toContain("0 errors");
  });

  it("exits 1 and names the check on a tampered magnitude", async () => {
    const b = clone(minimalBody());
    (b.tree as any).score.magnitude = 21;
    await expect(run("pnpm", ["-s", "eil", "reqs", "check", write(b)])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("SCORE-001"),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts -t "reqs check"`
Expected: FAIL — `unknown command 'reqs'`

- [ ] **Step 3: Implement `ts/reqs/io.ts` and wire the CLI**

Follow the existing `ts/cli.ts` command style exactly — `const reqs = program.command("reqs").description(...)`, then `.command("check <file>")`. Read an existing command such as `audit` for how the DB client is opened and closed, and reuse that pattern rather than inventing one.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-analyse.test.ts -t "reqs check"`
Expected: PASS.

- [ ] **Step 5: Rehearse the refusal by hand**

```bash
pnpm tsx -e "import{writeFileSync}from'node:fs';import{minimalBody}from'./ts/tests/helpers/reqs-fixture.js';import{assemble}from'./ts/reqs/assemble.js';writeFileSync('/tmp/reqs.json',JSON.stringify(assemble(minimalBody()),null,2))"
pnpm eil reqs check /tmp/reqs.json          # expect: 0 errors, exit 0
sed -i '' 's/"magnitude": 2/"magnitude": 21/' /tmp/reqs.json
pnpm eil reqs check /tmp/reqs.json; echo "exit=$?"   # expect: SCORE-001, exit=1
pnpm eil reqs render /tmp/reqs.json --out /tmp/reqs.html && open /tmp/reqs.html
```

Expected: the HTML shows the `REFUSED` banner naming `SCORE-001`. **This is beat 4. It has to feel instant and read clearly from the back of a room.**

- [ ] **Step 6: Commit**

```bash
git add ts/cli.ts ts/reqs/io.ts ts/tests/reqs-analyse.test.ts
git commit -m "feat: eil reqs check|render — the gate as an exit code"
```

---

## Task 9: The resolution cascade

**Files:**
- Create: `ts/reqs/ground.ts`
- Modify: `ts/llm/index.ts` — add `FixtureProvider` and register it in `getProvider`
- Test: `ts/tests/reqs-ground.test.ts`

**Interfaces:**
- Consumes: `callTool` from `../tools.js`; `REGISTERED_CONSTANTS`; `Grounding` from `schema.js`; `getProvider`, `parseJsonReply`, `logCall` from `../llm/index.js`.
- Produces:
  - `type Rung = "context" | "architecture" | "project_docs" | "knowledge_base" | "human"`
  - `interface Resolution { rung: Rung; grounding: Grounding[]; answer: string | null; confidence: { topScore: number; scoreGap: number; nAboveThreshold: number; armsContributing: number } | null }`
  - `resolveUnknown(question: string, deps: { client: Db; viewer: Viewer; repoRoot?: string; judge?: (question: string, docs: {docId:string;title:string;body:string}[]) => Promise<{ answers: boolean; quote: string; rationale: string }> }): Promise<Resolution>`

### The three-way split — implement exactly this

1. **Rungs 1–3** — read `CONTEXT.md`, `ARCHITECTURE.md`, then `docs/**/*.md` from `repoRoot` if present. Plain substring/keyword match. Cheap, local, tried first.
2. **Rung 4 arithmetic** — `callTool("search_docs", { query: question }, viewer)`. If `topScore < groundingTopScoreFloor`, there is nothing worth reading → fall to rung 5. If `scoreGap < groundingScoreGapFloor`, **the sources disagree** → fall to rung 5 with `answer: null`. Record the confidence numbers either way.
3. **Rung 4 judgment** — fetch the surviving documents with `callTool("get_doc", ...)` and hand them to `judge`, which returns `{ answers, quote, rationale }`. The model decides answerhood; it does not decide confidence.
4. **Rung 4 verification** — if `answers` is true, assert `quote` appears verbatim (whitespace-normalised) in the fetched body. If it does not, discard the grounding and fall to rung 5. **The cascade never emits a citation it has not itself verified**; `CLARIFY-005` is then a second line of defence at gate time, not the only one.
5. **Rung 5** — return `{ rung: "human", grounding: [], answer: null }`. The caller turns that into an open `Clarification`, which blocks the gate.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/reqs-ground.test.ts
import { describe, expect, it } from "vitest";
import { REGISTERED_CONSTANTS as K } from "../reqs/constants.js";

// The cascade is tested against a stubbed search/get_doc pair rather than a live
// database: the behaviour under test is the ORDER and the THRESHOLDS, not SQL.
describe("resolution cascade", () => {
  it("escalates to a human when nothing scores above the floor", async () => {
    // search returns topScore below K.groundingTopScoreFloor
    // expect rung === "human", grounding === [], and judge never called
  });

  it("escalates when the sources disagree, rather than picking one", async () => {
    // topScore above the floor, scoreGap below K.groundingScoreGapFloor
    // expect rung === "human" and confidence recorded
  });

  it("does not resolve an unknown from a document that only restates it", async () => {
    // PTR-420 body: the question, no answer. judge returns { answers: false }
    // expect rung === "human"
  });

  it("emits a verified citation when the judge finds an answer", async () => {
    // judge returns a quote that IS in the body
    // expect rung === "knowledge_base", grounding[0].quote === that quote
  });

  it("discards a citation whose quote is not in the document it claims", async () => {
    // judge returns a quote NOT in the body
    // expect rung === "human" and grounding === []
  });

  it("tries the local rungs before touching the knowledge base", async () => {
    // repoRoot with an ARCHITECTURE.md containing the answer
    // expect rung === "architecture" and search never called
  });
});
```

Fill each body in using a stub for `callTool` — inject it as a dependency on `resolveUnknown` rather than mocking the module, so the test stays a unit test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ts/tests/reqs-ground.test.ts`
Expected: FAIL — `Cannot find module '../reqs/ground.js'`

- [ ] **Step 3: Implement `ground.ts`, and add `FixtureProvider` to `ts/llm/index.ts`**

```ts
// add to ts/llm/index.ts
/**
 * Replays a recorded reply. Makes the elaboration loop deterministic in tests
 * and rehearsal, and lets the whole pipeline run on a machine where neither amp
 * nor copilot is installed. EIL_LLM_FIXTURE points at a JSON file mapping a
 * prompt hash to a reply.
 */
export class FixtureProvider implements Provider {
  name = "fixture";
  constructor(private replies: Record<string, string>) {}
  async complete(prompt: string, _opts: CompleteOptions = {}): Promise<LLMResult> {
    const key = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    const text = this.replies[key] ?? this.replies.default;
    if (text === undefined) throw new Error(`fixture provider: no reply for prompt ${key}`);
    return { text, provider: this.name, model: "fixture", latencyMs: 0 };
  }
}
```

Register `case "fixture":` in `getProvider`, loading `EIL_LLM_FIXTURE`. Add `import { createHash } from "node:crypto";` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ts/tests/reqs-ground.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ts/reqs/ground.ts ts/llm/index.ts ts/tests/reqs-ground.test.ts
git commit -m "feat: resolution cascade — arithmetic gates the read, the model judges answerhood, code verifies the quote"
```

---

## Task 10: The elaboration driver

**Files:**
- Create: `ts/reqs/prompt.ts`, `ts/reqs/elaborate.ts`
- Modify: `ts/cli.ts` — add `eil reqs elaborate <work-item>`
- Test: extend `ts/tests/reqs-ground.test.ts`

**Interfaces:**
- Consumes: `resolveUnknown`, `assemble`, `analyse`, `getProvider`, `logCall`, `parseJsonReply`, `nextAcId`.
- Produces: `elaborate(workItem: string, deps): Promise<ReqsBody>`; `SCORE_PROMPT`, `AC_PROMPT`, `JUDGE_PROMPT` from `prompt.js`.

**The model emits only bounded judgments.** Each prompt demands a single JSON object and nothing else:

- score: `{ unknowns: <one of 1,2,3,5,8,13,21>, complexity: <same>, rationale: <one line> }` — **no magnitude, no decision.** Those are computed.
- judge: `{ answers: boolean, quote: string, rationale: string }` — `quote` must be copied character-for-character from the supplied document.
- acceptance criteria: `{ criteria: [{ stakeholder, given, when, then: [...] }] }` — no ids; ids are allocated by `nextAcId`.

Every call goes through `logCall(client, "reqs-elaborate", result, ok)`, giving `llm_calls` its first production writer.

The loop, per node: score → `recommendAction` → if `clarify`, run `resolveUnknown` and record either a grounded clarification or an open one → if `decompose`, ask for child statements and recurse (respecting `maxDepth`) → if `leaf`, ask for acceptance criteria. Then `assemble`, then `analyse`, and **write the artefact even when it is refused** — a refused artefact plus its findings is the honest output, and it is what beat 3 shows.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/reqs-ground.test.ts
describe("elaborate", () => {
  it("computes magnitude and decision itself, ignoring anything the model offers", async () => {
    // fixture provider returns { unknowns: 8, complexity: 2, magnitude: 1, decision: "leaf", rationale: "x" }
    // expect the produced node: magnitude 8, decision NOT leaf
  });

  it("records an open clarification when the cascade reaches a human", async () => {
    // expect a clarification with no answeredBy, and analyse() -> CLARIFY-002
  });

  it("writes the artefact even when the gate refuses it", async () => {
    // expect a body returned with analysis.findings non-empty
  });

  it("never emits a sign-off", async () => {
    // sign-off is human-only and out of band
    // expect body.signoff === undefined
  });
});
```

- [ ] **Step 2–4: Fail, implement, pass**

Run: `pnpm vitest run ts/tests/reqs-ground.test.ts` at each stage.

- [ ] **Step 5: Produce the real artefact for the demo**

```bash
export EIL_DATABASE_URL=pglite://.eil-demo
export EIL_LLM_PROVIDER=amp          # copilot on the work machine
pnpm eil reqs elaborate PTR-401 --out demo/PTR-401.reqs.json
pnpm eil reqs check demo/PTR-401.reqs.json
pnpm eil reqs render demo/PTR-401.reqs.json --out demo/PTR-401.html
```

Expected: roughly 4 grounded and 3 escalated unknowns, per spec §8.1. **If the ratio is wildly different, fix the corpus, not the thresholds** — tuning `groundingTopScoreFloor` to reach a target ratio is exactly the self-certification the whole design exists to prevent.

- [ ] **Step 6: Commit**

```bash
git add ts/reqs/prompt.ts ts/reqs/elaborate.ts ts/cli.ts demo/PTR-401.reqs.json demo/PTR-401.html ts/tests/reqs-ground.test.ts
git commit -m "feat: elaboration driver — bounded judgments only, artefact written even when refused"
```

---

## Task 11: The clarification ledger and sign-off

**Files:**
- Create: `ts/reqs/ledger.ts`
- Modify: `ts/cli.ts` — add `eil reqs ledger <file>` and `eil reqs signoff <file>`
- Test: extend `ts/tests/reqs-analyse.test.ts`

**Interfaces:**
- Produces: `ledger(body: ReqsBody, client: Db): Promise<LedgerReport>` where `LedgerReport = { unknownsTotal, grounded, escalated, carried, hitRate, byRung: Record<Rung, number>, medianGroundingMs: number | null, escalations: { question: string; askedOf: string | null }[], retrievalTokens: 0 }`; `signoff(body, { name, role }): ReqsBody`.

`medianGroundingMs` comes from `audit_log.duration_ms` joined on the `traceId` values in the artefact's groundings — measured, not estimated. `retrievalTokens` is literally `0` and is structurally true: no LLM sits in EIL's query path.

`eil reqs signoff` appends one approver with `kind: "human"` and `result: "partial"`, then **re-runs the analyser and refuses to write if the artefact does not pass** — sign-off cannot be applied to a failing artefact.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/reqs-analyse.test.ts
describe("ledger", () => {
  it("reports a hit rate over unknowns, not over documents", async () => {
    // 4 grounded, 3 escalated -> hitRate 4/7
  });
  it("reports zero retrieval tokens, because there is no model in the query path", async () => {
    // expect retrievalTokens === 0
  });
  it("lists each escalation as an answerable question", async () => {
    // expect escalations.length === 3 and every question non-empty
  });
});

describe("signoff", () => {
  it("refuses to sign an artefact that does not pass the gate", async () => {
    // tampered magnitude -> signoff throws / returns an error
  });
  it("stamps kind human and result partial, never passed", async () => {
    // expect approver.kind === "human" && result === "partial"
  });
});
```

- [ ] **Step 2–4: Fail, implement, pass**

- [ ] **Step 5: Commit**

```bash
git add ts/reqs/ledger.ts ts/cli.ts ts/tests/reqs-analyse.test.ts
git commit -m "feat: clarification ledger and human-only sign-off"
```

---

## Task 12: Demo scripts and robustness

**Files:**
- Create: `demo/tamper.mjs`
- Modify: `demo/run.mjs` — embed step becomes optional; add the `reqs` steps
- Modify: `demo/README.md` — the narration script
- Modify: `README.md` — add `eil reqs` to the command list

**Interfaces:** none — this is the operator surface.

- [ ] **Step 1: Make the embed step optional**

In `demo/run.mjs` change the `embed backfill` step to `{ optional: true }` and the `ivf build` step likewise, and print `embeddings unavailable — running lexical arms only` when they fail. Rationale in a comment: `@huggingface/transformers` is an optional dependency that may not materialise behind a corporate proxy, and the four lexical arms are complete. Also correct the step-2 banner, which says "18 migrations" when there are 19.

- [ ] **Step 2: Write `demo/tamper.mjs`**

Six tampers, each: copy `demo/PTR-401.reqs.json` to a temp file, apply one mutation, run `eil reqs check`, print the expected check id beside the observed one, and assert they match.

| n | Mutation | Expect |
|---|---|---|
| 1 | first `score.magnitude` → `21` | `SCORE-001` |
| 2 | append ` Effective timing TBD.` to the root `statement` | `DEFER-001` |
| 3 | delete the first clarification, keep the `clarify` pass | `CLARIFY-001` |
| 4 | change one word inside the first `grounding[].quote` | `CLARIFY-005` |
| 5 | first approver `kind` → `"agent"` | `GATE-006` |
| 6 | `traceability` → `{}` | `META-002`, `TRACE-001` |

`--tamper <n>` runs one; no argument runs all six. Print the check id in a way that reads from the back of a room.

- [ ] **Step 3: Run it**

Run: `node demo/tamper.mjs`
Expected: six tampers, six matching refusals, exit 0. **A mismatch here is a demo-stopping bug — fix it now, not tomorrow.**

- [ ] **Step 4: Full rehearsal, fixtures mode**

```bash
rm -rf .eil-demo .eil-repos
export EIL_DATABASE_URL=pglite://.eil-demo
pnpm eil db migrate
pnpm corpus:build
for f in demo/fixtures/*.json; do
  case "$f" in *ptrd-*) pnpm eil ingest confluence --fixture "$f";; *) pnpm eil ingest jira --fixture "$f";; esac
done
pnpm eil stats:refresh
pnpm eil quarantine list
pnpm eil search "how do we handle a limit reduction"
pnpm eil reqs check demo/PTR-401.reqs.json
pnpm eil reqs ledger demo/PTR-401.reqs.json
node demo/tamper.mjs
pnpm eil audit
pnpm eil report --out demo/metrics.html
```

Expected: every step succeeds; `audit` reports `"ok": true`; `quarantine list` shows `ptrd-6`; `report` regenerates (the committed copy is stale and its LLM rows are hand-seeded — this run replaces them with real ones from `logCall`).

- [ ] **Step 5: Write the narration script into `demo/README.md`**

Seven beats per spec §11, with the exact command for each, the honest caveats from spec §14 marked **volunteer these**, and the §12 failure-mode table as a "if it breaks, say this" section.

- [ ] **Step 6: Final gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm map:check`
Expected: all green except the two pre-existing `step3.test.ts` failures if `@huggingface/transformers` is still absent. `map:check` is a CI gate and will fail if `ts/tools.ts` changed — it should not have.

- [ ] **Step 7: Commit**

```bash
git add demo README.md
git commit -m "feat: demo runner, six tamper demonstrations, embeddings made optional"
```

---

## Self-Review

**Spec coverage.** §3 in-scope items 1–9 map to Tasks 2, 3+4, 6+7, 5, 8+10+11, 9, 11, 1, 9. §4's three-way split is Task 9 steps 2–4. §5's schema is Task 3, with the `[G]` fields in Task 4. §6's constants are Task 2. All 42 checks in §7 appear in the Task 6 and Task 7 tables, and Task 7 step 5 asserts the count. §8's corpus is Task 1, and §8.1's outcome table is verified in Task 10 step 5. §9's two-mode operation is Task 1 step 5 (fixtures) and Task 12 step 4 (rehearsal), with `corpusMode` in the schema. §10's runtime is Task 9 step 3 plus Task 10. §11's arc and six tampers are Task 12. §12's failure modes are Task 12 step 5. §13's testing appears throughout. §14's caveats are Task 12 step 5.

**Gap found and closed:** §12 requires that a grounding which cannot be verified refuses the artefact rather than downgrading it. That is asserted in Task 7 step 1 (`CLARIFY-005` on an unresolvable document) and enforced a second time in the cascade at Task 9 step 3 item 4.

**Placeholder scan.** Task 5 step 3, Task 8 step 3, and Tasks 9–11's implementation steps describe requirements and interfaces rather than reproducing full code. This is deliberate for presentational and glue code where the interface is fully pinned and the repo has an established pattern to follow; every behavioural requirement is stated as an assertion in the preceding test step. `TRACE-007` is registered and returns `[]` by design, with the reason recorded — that is a decision, not a placeholder.

**Type consistency.** `Fib`, `Decision`, `Zone` are defined in Task 2 and used unchanged after. `Finding` is defined in Task 3's `schema.ts` and imported by every check. `Check`/`CheckContext` are defined in Task 6 and consumed unchanged in Task 7. `ReqsBody` fields referenced in Tasks 4–11 all exist in Task 3's schema. `resolveDoc: (docId: string) => Promise<string | null>` has the same signature in Tasks 6, 7 and 8. `assemble` returns `ReqsBody` everywhere. `walk` yields `{ node, depth, path }` in Task 3 and is destructured consistently thereafter.
