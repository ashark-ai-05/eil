import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../db.js";
import {
  FixtureProvider,
  type Provider,
  REPLAY_SUFFIX,
  RecordingProvider,
  getProvider,
  normalisePack,
  promptKey,
} from "../llm/index.js";
import { analyse } from "../reqs/analyse.js";
import { REGISTERED_CONSTANTS as K } from "../reqs/constants.js";
import { type ElaborateDeps, detectCorpusMode, elaborate } from "../reqs/elaborate.js";
import { type Judgment, type SearchDocsPayload, resolveUnknown } from "../reqs/ground.js";
import {
  AC_PROMPT,
  CHILDREN_PROMPT,
  JUDGE_PROMPT,
  QUESTION_PROMPT,
  SCORE_PROMPT,
} from "../reqs/prompt.js";
import { walk } from "../reqs/schema.js";
import { magnitude, recommendAction } from "../reqs/scoring.js";
import { viewerFromAuthenticatedClaims } from "../search.js";

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
      // A pack pointed at by the environment selects replay on its own: one
      // decision should not need two variables that can disagree.
      expect(getProvider().name).toBe("fixture");
    } finally {
      if (previous === undefined) delete process.env.EIL_LLM_FIXTURE;
      else process.env.EIL_LLM_FIXTURE = previous;
    }
  });

  /**
   * The pack format carries provenance because a replay that cannot say what
   * produced it is indistinguishable from a live call — the exact confusion
   * this whole phase exists to make impossible.
   */
  it("reports the pack's own provider and model, never the literal 'fixture'", async () => {
    const prompt = "what is the staleness cutoff?";
    const provider = new FixtureProvider({
      recordedAt: "2026-07-30T09:00:00.000Z",
      provider: "copilot",
      model: "gpt-5.2",
      note: "captured while rehearsing",
      replies: { [promptKey(prompt)]: { text: "5s", latencyMs: 0 } },
    });

    const res = await provider.complete(prompt);
    // The provider that produced the TEXT, and separately the fact of replay.
    expect(res.provider).toBe("copilot");
    expect(res.model).toBe("gpt-5.2");
    expect(res.provenance).toBe("replay");
    // The provider itself is still the fixture machinery; only the RESULT
    // speaks for the recording.
    expect(provider.name).toBe("fixture");
  });

  it("accepts the old flat Record<string, string> pack shape", () => {
    const pack = normalisePack({ abc: "one", default: "two" });
    expect(pack.replies).toEqual({ abc: { text: "one" }, default: { text: "two" } });
    // A pack with no provenance to report claims none: no model, no timing, and
    // the honest under-claim of "fixture" as the producer.
    expect(pack.provider).toBe("fixture");
    expect(pack.model).toBeNull();
    expect(pack.replies.abc?.latencyMs).toBeUndefined();
  });

  it("sleeps the recorded latency, so a replayed run keeps the rhythm of a real one", async () => {
    const prompt = "how long did this take?";
    const provider = new FixtureProvider({
      recordedAt: "2026-07-30T09:00:00.000Z",
      provider: "copilot",
      model: null,
      note: "",
      replies: { [promptKey(prompt)]: { text: "ok", latencyMs: 120 } },
    });

    const started = performance.now();
    const res = await provider.complete(prompt);
    const elapsed = performance.now() - started;
    // Reproduced, not invented: the reported latency is the RECORDED one, and
    // the call really took about that long.
    expect(res.latencyMs).toBe(120);
    expect(elapsed).toBeGreaterThanOrEqual(100);

    // A pack with no recorded latency waits for nothing at all.
    const instant = new FixtureProvider({ default: "ok" });
    const before = performance.now();
    expect((await instant.complete("anything")).latencyMs).toBe(0);
    expect(performance.now() - before).toBeLessThan(80);
  });
});

/** Recording is the other half of replay: without it a pack can only be typed
 *  out by hand, which is the thing the pack is supposed to replace. */
describe("RecordingProvider", () => {
  it("records prompt hash, reply and MEASURED latency, and replays identically", async () => {
    const dir = await repoWith({});
    const path = join(dir, "pack.json");
    const inner: Provider = {
      name: "copilot",
      async complete(_prompt) {
        await new Promise((r) => setTimeout(r, 60));
        return { text: "recorded reply", provider: "copilot", model: "gpt-5.2" };
      },
    };
    const recorder = new RecordingProvider(inner, path, "why this pack exists");

    const live = await recorder.complete("a prompt");
    expect(live.text).toBe("recorded reply");
    // The wrapper is transparent: it does not rename the backend it wraps.
    expect(recorder.name).toBe("copilot");

    // Written as the run proceeds, so a run that dies half way still leaves a
    // usable pack of what it got through.
    const pack = normalisePack(JSON.parse(await readFile(path, "utf-8")));
    expect(pack.provider).toBe("copilot");
    expect(pack.model).toBe("gpt-5.2");
    expect(pack.note).toBe("why this pack exists");
    expect(Date.parse(pack.recordedAt)).not.toBeNaN();
    const recorded = pack.replies[promptKey("a prompt")];
    expect(recorded?.text).toBe("recorded reply");
    // The wall time this call really took, not a number anybody chose.
    expect(recorded?.latencyMs).toBeGreaterThanOrEqual(50);

    const replayed = await new FixtureProvider(pack).complete("a prompt");
    expect(replayed.text).toBe("recorded reply");
    expect(replayed.provider).toBe("copilot");
    expect(replayed.provenance).toBe("replay");
  });
});

/**
 * The elaboration loop. Every one of these runs with a `FixtureProvider`, so
 * there is no live model anywhere in the suite; the wrapper below only decides
 * WHICH recorded reply the fixture replays, by looking for the instruction block
 * `prompt.ts` exports. That routing is itself an assertion: if a builder ever
 * stopped embedding its own instructions, every one of these tests would fail.
 */
type Scripted = Partial<Record<"score" | "children" | "question" | "criteria" | "judge", string>>;

function pickReply(replies: Scripted, prompt: string): string | undefined {
  if (prompt.includes(AC_PROMPT)) return replies.criteria;
  if (prompt.includes(CHILDREN_PROMPT)) return replies.children;
  if (prompt.includes(QUESTION_PROMPT)) return replies.question;
  if (prompt.includes(JUDGE_PROMPT)) return replies.judge;
  if (prompt.includes(SCORE_PROMPT)) return replies.score;
  return undefined;
}

function scriptedProvider(replies: Scripted, seen: string[] = []): Provider {
  const pick = (prompt: string): string | undefined => pickReply(replies, prompt);
  return {
    name: "fixture",
    async complete(prompt, opts) {
      seen.push(prompt);
      const reply = pick(prompt);
      if (reply === undefined)
        throw new Error(`no scripted reply for prompt: ${prompt.slice(0, 60)}`);
      // The replay itself is FixtureProvider's, keyed by the prompt hash exactly
      // as a recorded fixture file would be.
      return new FixtureProvider({ default: reply }).complete(prompt, opts);
    },
  };
}

/** Records every statement written to llm_calls, and answers the corpus probe. */
function recordingClient(
  corpus: { total: number; synthetic: number } = { total: 0, synthetic: 0 },
) {
  const calls: { text: string; params: any[] }[] = [];
  const client: Db = {
    async query(text: string, params: any[] = []) {
      calls.push({ text, params });
      if (/from documents/i.test(text)) return { rows: [corpus] };
      return { rows: [] };
    },
    async end() {},
  };
  return {
    client,
    calls,
    logged: () => calls.filter((c) => /insert into llm_calls/i.test(c.text)),
  };
}

/** A cascade that always escalates: nothing in the corpus scores above the floor. */
const NOTHING_FOUND = () => ({
  search: async () => searchPayload({ results: [], top_score: 0, score_gap: 0 }),
  fetchDoc: async () => null,
});

const BASE_REPLIES: Scripted = {
  score:
    '{"unknowns": 8, "complexity": 2, "magnitude": 1, "decision": "leaf", "rationale": "the amendment path is undecided"}',
  children:
    '{"children": ["Apply an approved amendment to the live limit picture", "Reject orders while the amended limit is not yet in force"]}',
  question:
    '{"question": "What happens to in-flight orders when a counterparty limit is reduced?"}',
  criteria:
    '{"criteria": [{"stakeholder": "Risk Ops", "given": "an approved amendment", "when": "the gateway receives the publish", "then": ["the snapshot records the new limit within 250ms"]}]}',
  judge:
    '{"answers": false, "quote": "", "rationale": "the corpus is about the question and does not answer it"}',
};

function deps(over: Partial<ElaborateDeps> = {}): ElaborateDeps {
  return {
    provider: scriptedProvider(BASE_REPLIES),
    title: "Intraday PSR limit amendment",
    brief: "A counterparty limit change made today only takes effect tomorrow.",
    corpusMode: "fixtures",
    escalateTo: "d.mercer",
    now: () => new Date("2026-07-30T09:00:00.000Z"),
    ...NOTHING_FOUND(),
    ...over,
  };
}

describe("elaborate", () => {
  it("computes magnitude and decision itself, ignoring anything the model offers", async () => {
    const body = await elaborate("PTR-401", deps());

    // The reply claimed magnitude 1 and decision "leaf" alongside unknowns 8.
    // Both claims are discarded: magnitude is max(8, 2) and the decision comes
    // from recommendAction, which cannot return "leaf" in the must_break_down
    // zone. Nothing the model said about either survives into the artefact.
    expect(body.tree.score.unknowns).toBe(8);
    expect(body.tree.score.complexity).toBe(2);
    expect(body.tree.score.magnitude).toBe(8);
    expect(body.tree.score.magnitude).toBe(magnitude(8, 2));
    expect(body.tree.score.decision).not.toBe("leaf");
    expect(body.tree.score.decision).toBe(recommendAction(8, 2));
    expect(body.tree.decision).toBe("decompose");
    expect(body.tree.isLeaf).toBe(false);
    // …and the same for every node the loop produced, not only the root.
    for (const { node } of walk(body.tree)) {
      expect(node.score.magnitude).toBe(magnitude(node.score.unknowns, node.score.complexity));
      expect(node.score.decision).not.toBe("leaf");
      for (const pass of node.scoreHistory)
        expect(pass.magnitude).toBe(magnitude(pass.unknowns, pass.complexity));
    }
    // The whole reply is not smuggled in under another key either.
    expect(JSON.stringify(body)).not.toContain('"decision":"leaf"');
  });

  it("records an open clarification when the cascade reaches a human, and the gate says so", async () => {
    const body = await elaborate("PTR-401", deps());

    expect(body.clarifications.length).toBeGreaterThan(0);
    for (const c of body.clarifications) {
      // Open: no answer at all, and no citation pretending there was one.
      expect(c.answer).toBeUndefined();
      expect(c.grounding).toEqual([]);
      expect(c.resolvedFrom).toBeUndefined();
      // …but the human who has to answer it is named.
      expect(c.answeredBy).toEqual({ kind: "human", name: "d.mercer" });
      expect(c.question).toContain("in-flight orders");
    }
    // Every node that recorded a clarify pass is named by a clarification,
    // which is CLARIFY-001's rule — so the refusal below is CLARIFY-002's alone.
    const asked = [...walk(body.tree)].filter((n) =>
      n.node.scoreHistory.some((p) => p.decision === "clarify"),
    );
    expect(asked.length).toBe(body.clarifications.length);

    const result = await analyse(body);
    expect(result.ok).toBe(false);
    expect(result.findings.filter((f) => f.id === "CLARIFY-002").length).toBe(
      body.clarifications.length,
    );
    expect(result.findings.some((f) => f.id === "CLARIFY-001")).toBe(false);
  });

  it("writes the artefact even when the gate refuses it", async () => {
    const dir = await repoWith({});
    const out = join(dir, "PTR-401.reqs.json");
    const body = await elaborate("PTR-401", deps({ out }));

    // Refused, and written anyway: a refused artefact plus its findings is the
    // honest output, and suppressing it would hide the only thing worth showing.
    expect(body.analysis).toBeDefined();
    expect(body.analysis?.findings.length).toBeGreaterThan(0);
    expect(body.analysis?.findings.some((f) => f.severity === "error")).toBe(true);
    const onDisk = JSON.parse(await readFile(out, "utf-8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(body)));
    // The written file is a body the analyser can read back and refuse again.
    const reread = await analyse(onDisk);
    expect(reread.ok).toBe(false);
    expect(reread.findings.map((f) => f.id).sort()).toEqual(
      (body.analysis?.findings ?? []).map((f) => f.id).sort(),
    );
  });

  it("never emits a sign-off", async () => {
    const body = await elaborate("PTR-401", deps());
    // Sign-off is human-only and out of band. The loop has no code path to it.
    expect(body.signoff).toBeUndefined();
    expect("signoff" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("signoff");
  });

  it("logs every model call to llm_calls as reqs-elaborate, with no invented token counts", async () => {
    const seen: string[] = [];
    const rec = recordingClient();
    await elaborate(
      "PTR-401",
      deps({ provider: scriptedProvider(BASE_REPLIES, seen), client: rec.client }),
    );

    const logged = rec.logged();
    // One row per model call, and not one more.
    expect(seen.length).toBeGreaterThan(0);
    expect(logged.length).toBe(seen.length);
    for (const row of logged) {
      expect(row.text).toContain("llm_calls");
      expect(row.params[0]).toBe("fixture"); // provider
      // These replies were REPLAYED out of a pack, and the ledger says so. The
      // caller carries the marker, not the provider column: `provider` answers
      // "who produced this judgment" and `caller` answers "what did this run
      // spend" — and a replay spent nothing.
      expect(row.params[2]).toBe(`reqs-elaborate${REPLAY_SUFFIX}`); // caller
      // CliProvider reports no usage, so counts stay null rather than invented.
      expect(row.params[3]).toBeNull();
      expect(row.params[4]).toBeNull();
      expect(row.params[6]).toBe(true); // ok
    }
  });

  /**
   * The same rule `corpusMode` holds for the corpus, held for the judgments: a
   * run that replayed a pack must not be presentable as a live model call.
   */
  it("stamps generator.provenance from the replies, and names what produced them", async () => {
    const pick = (prompt: string): string => pickReply(BASE_REPLIES, prompt) ?? "";
    const replayed = await elaborate("PTR-401", deps());
    // BASE_REPLIES goes through FixtureProvider, so this run IS a replay — and
    // the legacy flat pack it uses has no producer to name beyond itself.
    expect(replayed.metadata.generator.provenance).toBe("replay");
    expect(replayed.metadata.generator.agent).toBe("eil reqs elaborate via fixture");

    // A pack that names its producer puts THAT in the artefact: the reader is
    // told what produced the judgments AND that they were replayed.
    const pack = {
      recordedAt: "2026-07-30T09:00:00.000Z",
      provider: "copilot",
      model: "gpt-5.2",
      note: "",
      replies: {} as Record<string, { text: string }>,
    };
    const viaPack: Provider = {
      name: "fixture",
      complete: (prompt, opts) =>
        new FixtureProvider({ ...pack, replies: { default: { text: pick(prompt) } } }).complete(
          prompt,
          opts,
        ),
    };
    const named = await elaborate("PTR-401", deps({ provider: viaPack }));
    expect(named.metadata.generator.provenance).toBe("replay");
    expect(named.metadata.generator.agent).toBe("eil reqs elaborate via copilot");
    expect(named.metadata.generator.model).toBe("gpt-5.2");

    // And a provider that answers for itself is live, with no replay marker.
    const liveProvider: Provider = {
      name: "maas",
      async complete(prompt) {
        return { text: pick(prompt), provider: "maas", model: "nemotron" };
      },
    };
    const live = await elaborate("PTR-401", deps({ provider: liveProvider }));
    expect(live.metadata.generator.provenance).toBe("live");
    expect(live.metadata.generator.agent).toBe("eil reqs elaborate via maas");
  });

  it("records the run to a pack that replays to the same artefact", async () => {
    const pick = (prompt: string): string => pickReply(BASE_REPLIES, prompt) ?? "";
    const dir = await repoWith({});
    const path = join(dir, "pack.json");
    const recorded = await elaborate(
      "PTR-401",
      deps({
        provider: {
          name: "maas",
          async complete(p) {
            return { text: pick(p), provider: "maas", model: "nemotron" };
          },
        },
        record: path,
        recordNote: "recorded while rehearsing",
      }),
    );
    expect(recorded.metadata.generator.provenance).toBe("live");

    const pack = normalisePack(JSON.parse(await readFile(path, "utf-8")));
    expect(pack.provider).toBe("maas");
    expect(pack.model).toBe("nemotron");
    expect(pack.note).toBe("recorded while rehearsing");
    expect(Object.keys(pack.replies).length).toBeGreaterThan(0);

    // Replaying the pack reproduces the same tree from the same prompts — which
    // is the whole claim a recorded run makes.
    const replayed = await elaborate("PTR-401", deps({ provider: new FixtureProvider(pack) }));
    expect(replayed.tree).toEqual(recorded.tree);
    expect(replayed.metadata.generator.provenance).toBe("replay");
    expect(replayed.metadata.generator.agent).toBe("eil reqs elaborate via maas");
  });

  it("stamps corpusMode from the catalog it actually read, not from a flag", async () => {
    const fixtures = recordingClient({ total: 13, synthetic: 13 });
    const live = recordingClient({ total: 13, synthetic: 4 });

    // Tenant is required now: omitting it used to widen the query to the whole
    // catalog silently, so the dangerous case was the default.
    expect(await detectCorpusMode(fixtures.client, "default")).toBe("fixtures");
    expect(await detectCorpusMode(live.client, "default")).toBe("live");

    // A viewer is now REQUIRED to derive corpusMode from the catalog, because
    // deriving it needs to know whose catalog. This test previously relied on
    // the silent fall-through to a whole-catalog count — exactly the path that
    // let one tenant's corpus decide another tenant's verdict.
    const body = await elaborate(
      "PTR-401",
      deps({
        client: live.client,
        corpusMode: undefined,
        title: "Intraday PSR limit amendment",
        viewer: viewerFromAuthenticatedClaims({
          principal: "reader",
          tenant: "default",
          groups: [],
        }),
      }),
    );
    expect(body.metadata.corpusMode).toBe("live");
  });
});
