import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureProvider, getProvider } from "../llm/index.js";
import { REGISTERED_CONSTANTS as K } from "../reqs/constants.js";
import { type Judgment, type SearchDocsPayload, resolveUnknown } from "../reqs/ground.js";

/**
 * The unknown the demo actually lands on. It is deliberately the one PTR-420 is
 * ABOUT and does not ANSWER, because that is the case a confidence-only cascade
 * gets wrong.
 */
const QUESTION = "What happens to in-flight orders when a counterparty limit is reduced?";

/**
 * PTR-420, near enough verbatim from ts/corpus/psr.ts: it restates the question
 * and answers nothing. Every content word of the question is in here, so it
 * scores at the top of lexical retrieval — aboutness, not answerhood.
 */
const PTR_420 = `# PTR-420 — Decide in-flight order treatment on limit reduction

When a counterparty limit is reduced, we have no agreed answer for orders that
are already working at the venue. It is written down nowhere, and today's
behaviour is whatever the code happens to do rather than anything anyone chose.`;

/**
 * A page that does answer it. The answering sentence is WRAPPED — the quote the
 * judge returns is one line — so a passing verification proves whitespace is
 * normalised on both sides rather than the two strings happening to be equal.
 */
const PTRD_2 = `## Counterparty limit reduction

When a counterparty limit is reduced below current exposure, orders already
working at the venue are cancelled immediately, and the reduced limit applies to
new orders only once every cancel is acknowledged.`;

const VERIFIABLE_QUOTE = "orders already working at the venue are cancelled immediately";
const FABRICATED_QUOTE = "orders already working at the venue are amended to the new limit";

/**
 * Exactly the payload `callTool("search_docs", ...)` returns — snake_case
 * `top_score` / `score_gap` / `n_above_threshold` / `arms_contributing` as
 * `confidence()` in ts/search.ts emits them, `results[]` as `SearchResult`
 * declares them, plus the `trace_id` callTool appends. Written out in full so
 * the stub is a statement about EIL's real contract, not a convenience shape.
 */
function searchPayload(over: Partial<SearchDocsPayload> = {}): SearchDocsPayload {
  return {
    route: "keyword",
    executor: "fts_prose+fts_prose_loose+vec",
    results: [
      {
        id: "jira:issue:PTR-420",
        title: "PTR-420 — Decide in-flight order treatment on limit reduction",
        url: "https://jira.example.com/browse/PTR-420",
        tier: "b",
        snippet: "…no agreed answer for orders that are already working…",
        score: 0.41,
      },
    ],
    top_score: 0.41,
    score_gap: 0.19,
    n_above_threshold: 1,
    arms_contributing: 3,
    trace_id: "trace-abc",
    ...over,
  };
}

function stubSearch(payload: SearchDocsPayload) {
  const calls: string[] = [];
  return {
    calls,
    fn: async (query: string) => {
      calls.push(query);
      return payload;
    },
  };
}

/** Mirrors makeDocResolver's contract: the reassembled body text, or null. */
function stubFetch(bodies: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    fn: async (docId: string) => {
      calls.push(docId);
      return bodies[docId] ?? null;
    },
  };
}

function stubJudge(judgment: Judgment) {
  const calls: { question: string; docs: { docId: string; title: string; body: string }[] }[] = [];
  return {
    calls,
    fn: async (question: string, docs: { docId: string; title: string; body: string }[]) => {
      calls.push({ question, docs });
      return judgment;
    },
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eil-ground-"));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf-8");
  }
  return dir;
}

// The cascade is tested against a stubbed search/get_doc pair rather than a live
// database: the behaviour under test is the ORDER and the THRESHOLDS, not SQL.
describe("resolution cascade", () => {
  it("escalates to a human when nothing scores above the floor", async () => {
    const below = K.groundingTopScoreFloor - 0.01;
    const search = stubSearch(
      searchPayload({ top_score: below, results: [{ id: "jira:issue:PTR-420", score: below }] }),
    );
    const fetchDoc = stubFetch({ "jira:issue:PTR-420": PTR_420 });
    const judge = stubJudge({ answers: true, quote: VERIFIABLE_QUOTE, rationale: "never asked" });

    const res = await resolveUnknown(QUESTION, {
      search: search.fn,
      fetchDoc: fetchDoc.fn,
      judge: judge.fn,
    });

    expect(res.rung).toBe("human");
    expect(res.grounding).toEqual([]);
    expect(res.answer).toBeNull();
    // Arithmetic decided there was nothing worth reading, so nothing was read
    // and no tokens were spent deciding that.
    expect(judge.calls).toHaveLength(0);
    expect(fetchDoc.calls).toHaveLength(0);
    expect(search.calls).toEqual([QUESTION]);
    // The escalation is auditable: the numbers that caused it are on the result.
    expect(res.confidence).toEqual({
      topScore: below,
      scoreGap: 0.19,
      nAboveThreshold: 1,
      armsContributing: 3,
    });
  });

  it("escalates when the sources disagree, rather than picking one", async () => {
    const gap = K.groundingScoreGapFloor - 0.005;
    const search = stubSearch(searchPayload({ top_score: 0.4, score_gap: gap }));
    const fetchDoc = stubFetch({ "jira:issue:PTR-420": PTR_420 });
    const judge = stubJudge({ answers: true, quote: VERIFIABLE_QUOTE, rationale: "never asked" });

    const res = await resolveUnknown(QUESTION, {
      search: search.fn,
      fetchDoc: fetchDoc.fn,
      judge: judge.fn,
    });

    expect(res.rung).toBe("human");
    expect(res.grounding).toEqual([]);
    expect(res.answer).toBeNull();
    expect(judge.calls).toHaveLength(0);
    expect(fetchDoc.calls).toHaveLength(0);
    // A flat result set is a disagreement, not a tie to be broken — and the gap
    // that caused the escalation is recorded rather than merely acted on.
    expect(res.confidence).toEqual({
      topScore: 0.4,
      scoreGap: gap,
      nAboveThreshold: 1,
      armsContributing: 3,
    });
  });

  it("does not resolve an unknown from a document that only restates it", async () => {
    // THE most important test in the task. PTR-420 tops retrieval for exactly
    // the unknown it fails to resolve, so if arithmetic alone were allowed to
    // decide grounded-vs-escalated, this unknown would be reported RESOLVED
    // against a document that contains no answer.
    const search = stubSearch(searchPayload());
    const fetchDoc = stubFetch({ "jira:issue:PTR-420": PTR_420 });
    // The quote is real and IS in PTR-420 — verification would pass it. The only
    // thing standing between this document and a bogus "resolved" is the
    // judge's verdict on answerhood, which is the point of the test.
    const judge = stubJudge({
      answers: false,
      quote: "we have no agreed answer for orders that are already working at the venue",
      rationale: "states the question and records that no decision has been taken",
    });

    const res = await resolveUnknown(QUESTION, {
      search: search.fn,
      fetchDoc: fetchDoc.fn,
      judge: judge.fn,
    });

    // Arithmetic let it through: the score cleared both floors.
    expect(search.calls).toEqual([QUESTION]);
    expect(res.confidence?.topScore).toBeGreaterThanOrEqual(K.groundingTopScoreFloor);
    expect(res.confidence?.scoreGap).toBeGreaterThanOrEqual(K.groundingScoreGapFloor);
    // The judge saw the real body, and answerhood is what it ruled on.
    expect(fetchDoc.calls).toEqual(["jira:issue:PTR-420"]);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.question).toBe(QUESTION);
    expect(judge.calls[0]?.docs[0]?.body).toContain("no agreed answer for orders");
    // And the verdict is escalation, not a citation of an unanswered ticket.
    expect(res.rung).toBe("human");
    expect(res.grounding).toEqual([]);
    expect(res.answer).toBeNull();
  });

  it("emits a verified citation when the judge finds an answer", async () => {
    const search = stubSearch(
      searchPayload({
        results: [
          {
            id: "confluence:page:ptrd-2",
            title: "PSR — counterparty limits",
            url: "https://confluence.example.com/x/ptrd-2",
            tier: "a",
            score: 0.44,
          },
        ],
        top_score: 0.44,
      }),
    );
    const fetchDoc = stubFetch({ "confluence:page:ptrd-2": PTRD_2 });
    const judge = stubJudge({
      answers: true,
      quote: VERIFIABLE_QUOTE,
      rationale: "states the treatment of working orders explicitly",
    });

    const res = await resolveUnknown(QUESTION, {
      search: search.fn,
      fetchDoc: fetchDoc.fn,
      judge: judge.fn,
    });

    expect(res.rung).toBe("knowledge_base");
    expect(res.grounding).toHaveLength(1);
    const g = res.grounding[0]!;
    expect(g.quote).toBe(VERIFIABLE_QUOTE);
    // The quote is wrapped across two lines in the body — a match here is only
    // possible because whitespace is normalised on BOTH sides.
    expect(PTRD_2).not.toContain(VERIFIABLE_QUOTE);
    expect(g.docId).toBe("confluence:page:ptrd-2");
    expect(g.title).toBe("PSR — counterparty limits");
    expect(g.url).toBe("https://confluence.example.com/x/ptrd-2");
    expect(g.source).toBe("confluence");
    expect(g.hedged).toBe(false);
    expect(g.traceId).toBe("trace-abc");
    expect(Number.isNaN(Date.parse(g.retrievedAt))).toBe(false);
    expect(res.answer).toBe(VERIFIABLE_QUOTE);
    expect(res.confidence?.topScore).toBe(0.44);
  });

  it("discards a citation whose quote is not in the document it claims", async () => {
    const search = stubSearch(
      searchPayload({
        results: [{ id: "confluence:page:ptrd-2", title: "PSR", score: 0.44 }],
        top_score: 0.44,
      }),
    );
    const fetchDoc = stubFetch({ "confluence:page:ptrd-2": PTRD_2 });
    const judge = stubJudge({
      answers: true,
      quote: FABRICATED_QUOTE,
      rationale: "plausible, and not in the document",
    });

    const res = await resolveUnknown(QUESTION, {
      search: search.fn,
      fetchDoc: fetchDoc.fn,
      judge: judge.fn,
    });

    // The cascade never emits a citation it has not itself verified: the
    // fabrication is discarded at source, not left for CLARIFY-005 at the gate.
    expect(res.rung).toBe("human");
    expect(res.grounding).toEqual([]);
    expect(res.answer).toBeNull();
    expect(judge.calls).toHaveLength(1);
    expect(res.confidence?.topScore).toBe(0.44);
  });

  it("tries the local rungs before touching the knowledge base", async () => {
    const repoRoot = await repoWith({
      "ARCHITECTURE.md": `# Architecture\n\n## Risk gateway\n\n${PTRD_2}\n`,
    });
    const search = stubSearch(searchPayload());
    const fetchDoc = stubFetch({});
    const judge = stubJudge({ answers: true, quote: VERIFIABLE_QUOTE, rationale: "never asked" });

    const res = await resolveUnknown(QUESTION, {
      repoRoot,
      search: search.fn,
      fetchDoc: fetchDoc.fn,
      judge: judge.fn,
    });

    expect(res.rung).toBe("architecture");
    expect(res.answer).toContain("cancelled immediately");
    // Cheap, local and first: no retrieval, no model call, no confidence numbers
    // because no arithmetic was needed.
    expect(search.calls).toEqual([]);
    expect(judge.calls).toHaveLength(0);
    expect(res.confidence).toBeNull();
    // Repo-local prose is not a catalog document, so it is not cited as one —
    // a docId get_doc cannot resolve would fail CLARIFY-005 at the gate.
    expect(res.grounding).toEqual([]);
  });

  // Not in the brief's six, but the brief's subject is the ORDER of the rungs,
  // and rungs 1 -> 2 -> 3 are otherwise only ever exercised at rung 2.
  it("walks the local rungs in order: CONTEXT.md, then ARCHITECTURE.md, then docs/", async () => {
    const answering = `## Counterparty limit reduction\n\n${PTRD_2}`;
    const local = async (files: Record<string, string>) => {
      const search = stubSearch(searchPayload());
      const res = await resolveUnknown(QUESTION, {
        repoRoot: await repoWith(files),
        search: search.fn,
        fetchDoc: stubFetch({}).fn,
        judge: stubJudge({ answers: false, quote: "", rationale: "never asked" }).fn,
      });
      // A rung that answers locally spends no retrieval; one that does not, does.
      return { rung: res.rung, searched: search.calls.length };
    };

    // Both answer; the nearer rung wins and the further one is never reached.
    expect(await local({ "CONTEXT.md": answering, "ARCHITECTURE.md": answering })).toEqual({
      rung: "context",
      searched: 0,
    });
    expect(await local({ "ARCHITECTURE.md": answering })).toEqual({
      rung: "architecture",
      searched: 0,
    });
    expect(await local({ "docs/risk/limits.md": answering })).toEqual({
      rung: "project_docs",
      searched: 0,
    });
    // Local prose that is merely ON TOPIC does not resolve anything: the cascade
    // carries on to rung 4, which is the same aboutness/answerhood distinction
    // the judge makes, applied with a keyword match.
    expect(await local({ "CONTEXT.md": "# Context\n\nThis service prices orders.\n" })).toEqual({
      rung: "human",
      searched: 1,
    });
  });
});

/**
 * The fixture provider is what lets the elaboration loop run identically in CI,
 * in rehearsal, and on a laptop with neither amp nor copilot installed.
 */
describe("FixtureProvider", () => {
  it("replays a reply keyed by the sha256 prefix of the prompt", async () => {
    const prompt = "does this document answer the question?";
    const key = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    const provider = new FixtureProvider({ [key]: '{"answers": true}', default: "unused" });

    const res = await provider.complete(prompt);
    expect(res.text).toBe('{"answers": true}');
    expect(res.provider).toBe("fixture");
    // A prompt with no recorded reply falls back to `default` rather than
    // reaching for a network the machine may not have.
    expect((await provider.complete("some other prompt")).text).toBe("unused");
    await expect(new FixtureProvider({}).complete(prompt)).rejects.toThrow(/no reply for prompt/);
  });

  it("is selectable as a provider, loading replies from EIL_LLM_FIXTURE", async () => {
    const dir = await repoWith({ "replies.json": JSON.stringify({ default: "recorded" }) });
    const previous = process.env.EIL_LLM_FIXTURE;
    process.env.EIL_LLM_FIXTURE = join(dir, "replies.json");
    try {
      const provider = getProvider("fixture");
      expect(provider.name).toBe("fixture");
      expect((await provider.complete("anything")).text).toBe("recorded");
    } finally {
      if (previous === undefined) delete process.env.EIL_LLM_FIXTURE;
      else process.env.EIL_LLM_FIXTURE = previous;
    }
  });
});
