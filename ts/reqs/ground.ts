/**
 * The resolution cascade — the seam between the delivery pipeline and the
 * knowledge plane. It decides whether an unknown is answered from the
 * organisation's own writing or escalated to a named human, and every unknown it
 * resolves from grounding is a clarification round-trip that did not happen.
 *
 * Responsibility is split three ways, and the split is the point:
 *
 *   arithmetic  decides whether there is anything worth READING at all —
 *               EIL's own confidence numbers against REGISTERED_CONSTANTS
 *   the model   decides whether what was read ANSWERS the question, and which
 *               exact words say so: { answers, quote, rationale }
 *   code        decides whether that quote is REALLY IN the cited document —
 *               substring test after whitespace normalisation, nothing else
 *
 * A two-way split (arithmetic decides grounded-vs-escalated) is broken, and the
 * failing case is in our own corpus: Jira issue PTR-420 — "Decide in-flight
 * order treatment on limit reduction", status Open — restates the unknown and
 * answers nothing, while topping lexical retrieval for exactly that unknown.
 * Retrieval scores measure ABOUTNESS, not ANSWERHOOD. So arithmetic may only
 * gate the read; the model rules on answerhood; and code refuses to emit a
 * citation it has not itself verified. CLARIFY-005 at gate time is then a second
 * line of defence rather than the only one.
 *
 * The rungs, in order — cheapest and most local first:
 *
 *   1  CONTEXT.md        repo-local, if present
 *   2  ARCHITECTURE.md   repo-local, if present
 *   3  docs/ ** / *.md   project docs
 *   4  knowledge base    search_docs -> get_doc -> judge -> verify   (EIL)
 *   5  a named human     the caller turns this into an open Clarification,
 *                        which blocks the gate
 *
 * Collaborators are INJECTED, not imported: the search function, the document
 * fetcher and the judge. That is what lets the order of the rungs and the
 * threshold behaviour be tested with stubs, with no database and no model.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db.js";
import type { Viewer } from "../search.js";
import { REGISTERED_CONSTANTS as K } from "./constants.js";
import { makeDocResolver } from "./io.js";
import type { Grounding, RESOLVED_FROM } from "./schema.js";

/** The rungs are exactly `RESOLVED_FROM`, so a Resolution names a value the
 *  artefact can already record on a node or a clarification. */
export type Rung = (typeof RESOLVED_FROM)[number];

/** EIL's four retrieval signals, camelCased for this module's consumers. The
 *  wire names are snake_case — see `SearchDocsPayload`. */
export interface Confidence {
  topScore: number;
  scoreGap: number;
  nAboveThreshold: number;
  armsContributing: number;
}

export interface Resolution {
  rung: Rung;
  grounding: Grounding[];
  /** the verbatim text that answers the question, or null when nothing does */
  answer: string | null;
  /** the numbers that admitted or refused the read; null when no search ran */
  confidence: Confidence | null;
}

/** One hit as `searchDocs` builds it (ts/search.ts, `SearchResult`). */
export interface SearchHit {
  id: string;
  title?: string | null;
  url?: string | null;
  tier?: string;
  snippet?: string;
  score?: number;
}

/**
 * What `callTool("search_docs", { query }, viewer, client)` actually returns.
 * The confidence fields are snake_case — `confidence()` in ts/search.ts emits
 * `top_score`, `score_gap`, `n_above_threshold`, `arms_contributing` — and
 * `trace_id` is appended by callTool itself. Read the real names; do not guess.
 */
export interface SearchDocsPayload {
  route?: string;
  executor?: string;
  results?: SearchHit[];
  top_score?: number;
  score_gap?: number;
  n_above_threshold?: number;
  arms_contributing?: number;
  trace_id?: string;
  error?: string;
}

export type SearchFn = (query: string) => Promise<SearchDocsPayload>;

/**
 * The document fetcher, deliberately the same contract as `makeDocResolver`:
 * the reassembled body text, or null when the document does not exist OR the
 * viewer may not read it. `callTool("get_doc", { id, section })` returns
 * `{ id, title, url, source, tier, hierarchy, updated_at, section,
 * total_sections, body, trace_id }` — or `{ error: "not found: <id>" }` — and
 * windows large bodies, which is exactly the stitching makeDocResolver already
 * does under the caller's ACL viewer. Title and url come from the search hit,
 * so nothing here needs a second copy of that logic.
 */
export type DocFetcher = (docId: string) => Promise<string | null>;

export interface JudgeDoc {
  docId: string;
  title: string;
  body: string;
}

/** The model's bounded judgment. It rules on answerhood only — never on
 *  confidence, and never on whether the quote is real. */
export interface Judgment {
  answers: boolean;
  quote: string;
  rationale: string;
}

export type JudgeFn = (question: string, docs: JudgeDoc[]) => Promise<Judgment>;

export interface ResolveDeps {
  /** reused for search_docs/get_doc so the cascade does not open a connection per document */
  client?: Db;
  viewer?: Viewer;
  /** absent means "no repo to read": rungs 1-3 are skipped rather than guessed at */
  repoRoot?: string;
  search?: SearchFn;
  fetchDoc?: DocFetcher;
  judge?: JudgeFn;
}

/** Enough hits that `n_above_threshold` is meaningful, few enough to stay cheap. */
const SEARCH_LIMIT = 8;

/** Documents handed to the judge in one call. The prompt is bounded by design:
 *  the model is asked a small question about a little text. */
const MAX_DOCS_JUDGED = 3;

/** Body text per document in the judge prompt. */
const MAX_JUDGE_CHARS = 6000;

/** Files scanned under docs/, sorted, so rung 3 cannot become a corpus read. */
const MAX_PROJECT_DOCS = 40;

/** A local paragraph must carry this share of the question's content words, and
 *  at least MIN_LOCAL_TERMS of them, before it counts as an answer. Rungs 1-3
 *  are a cheap keyword match — deliberately not a retrieval engine. */
const LOCAL_TERM_RATIO = 0.6;
const MIN_LOCAL_TERMS = 2;

/** Runs of whitespace to a single space, and NOTHING else — no case folding, no
 *  punctuation stripping. Applied to both sides, exactly as CLARIFY-005 does it,
 *  so what this module accepts and what the gate re-checks cannot diverge. */
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

/** Interrogatives and glue: words whose presence says nothing about topic. */
const STOPWORDS = new Set([
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "does",
  "did",
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "that",
  "this",
  "with",
  "from",
  "into",
  "its",
  "our",
  "their",
  "them",
  "they",
  "then",
  "than",
  "not",
  "but",
  "all",
  "any",
  "can",
  "may",
  "must",
  "shall",
  "will",
  "would",
  "should",
  "could",
  "have",
  "has",
  "had",
  "been",
  "about",
  "after",
  "before",
  "during",
  "while",
  "there",
  "here",
]);

/** Distinct lowercase content words, hyphens kept so "in-flight" stays one term. */
function contentTerms(question: string): string[] {
  const raw = question.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(raw)].filter((t) => !STOPWORDS.has(t));
}

/** The best-matching paragraph of a local file, or null when none qualifies. */
function matchLocal(question: string, text: string): string | null {
  const terms = contentTerms(question);
  if (terms.length === 0) return null;
  let best: { hits: number; paragraph: string } | null = null;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const flat = normalise(paragraph);
    const hay = flat.toLowerCase();
    const hits = terms.filter((t) => hay.includes(t)).length;
    if (hits < MIN_LOCAL_TERMS || hits / terms.length < LOCAL_TERM_RATIO) continue;
    if (!best || hits > best.hits) best = { hits, paragraph: flat };
  }
  return best?.paragraph ?? null;
}

/** Missing and unreadable are the same thing here: the rung simply does not fire. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function projectDocs(repoRoot: string): Promise<string[]> {
  const dir = join(repoRoot, "docs");
  try {
    const entries = await readdir(dir, { recursive: true });
    return entries
      .filter((e) => e.endsWith(".md"))
      .sort() // deterministic order: the same repo resolves the same way twice
      .slice(0, MAX_PROJECT_DOCS)
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
}

/**
 * Rungs 1-3. No grounding is emitted: repo-local prose is not a catalog
 * document, and a `docId` that `get_doc` cannot resolve would fail CLARIFY-005
 * at the gate — fail-closed, and correctly so. The rung itself is the
 * provenance, which is what `resolvedFrom` is for.
 */
async function tryLocal(
  question: string,
  repoRoot: string | undefined,
): Promise<Resolution | null> {
  if (!repoRoot) return null;
  const rooted: [Rung, string][] = [
    ["context", "CONTEXT.md"],
    ["architecture", "ARCHITECTURE.md"],
  ];
  for (const [rung, name] of rooted) {
    const text = await readIfPresent(join(repoRoot, name));
    const hit = text === null ? null : matchLocal(question, text);
    if (hit) return { rung, grounding: [], answer: hit, confidence: null };
  }
  for (const path of await projectDocs(repoRoot)) {
    const text = await readIfPresent(path);
    const hit = text === null ? null : matchLocal(question, text);
    if (hit) return { rung: "project_docs", grounding: [], answer: hit, confidence: null };
  }
  return null;
}

function readConfidence(payload: SearchDocsPayload): Confidence {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    topScore: num(payload.top_score),
    scoreGap: num(payload.score_gap),
    nAboveThreshold: num(payload.n_above_threshold),
    armsContributing: num(payload.arms_contributing),
  };
}

/** "confluence:page:ptrd-2" -> "confluence". The canonical id carries its own
 *  provenance, so nothing has to be re-queried to fill in `Grounding.source`. */
const sourceOf = (docId: string) => docId.split(":")[0] || "knowledge_base";

/**
 * Rung 4. Arithmetic gates the read, the judge rules on answerhood, this
 * function verifies the quote — and any of the three refusing lands on rung 5
 * with the confidence numbers still recorded, so the escalation is auditable.
 */
async function tryKnowledgeBase(
  question: string,
  search: SearchFn,
  fetchDoc: DocFetcher,
  judge: JudgeFn,
): Promise<Resolution> {
  let confidence: Confidence | null = null;
  const escalate = (): Resolution => ({
    rung: "human",
    grounding: [],
    answer: null,
    confidence,
  });
  try {
    const payload = await search(question);
    confidence = readConfidence(payload);
    if (typeof payload.error === "string") {
      console.error(`search_docs refused: ${payload.error} — escalating to a human`);
      return escalate();
    }
    // Nothing worth reading. Note what is NOT spent here: no get_doc, no tokens.
    if (confidence.topScore < K.groundingTopScoreFloor) return escalate();
    // The sources disagree. A flat result set is not a tie to be broken by
    // picking the top row — that is how a confident wrong answer gets made.
    if (confidence.scoreGap < K.groundingScoreGapFloor) return escalate();

    // How many hits are near the top rather than tailing off is EIL's own
    // arithmetic (`n_above_threshold`); the cascade reads it instead of
    // re-deriving a cut of its own, and caps it so the prompt stays bounded.
    const near = Math.min(Math.max(confidence.nAboveThreshold, 1), MAX_DOCS_JUDGED);
    const hits = (payload.results ?? []).slice(0, near);
    const fetched: { hit: SearchHit; body: string }[] = [];
    for (const hit of hits) {
      const body = await fetchDoc(hit.id);
      // null is "absent or invisible to this viewer" — indistinguishable by
      // design, and either way there is nothing to judge.
      if (body !== null && body.trim() !== "") fetched.push({ hit, body });
    }
    if (fetched.length === 0) return escalate();

    const judgment = await judge(
      question,
      fetched.map(({ hit, body }) => ({
        docId: hit.id,
        title: hit.title ?? hit.id,
        body: body.slice(0, MAX_JUDGE_CHARS),
      })),
    );
    if (!judgment.answers) return escalate();
    const quote = judgment.quote.trim();
    if (quote === "") return escalate();

    // Verification also decides ATTRIBUTION: the document that contains the
    // quote is the document that gets cited, so the model never gets to name a
    // source it did not quote from.
    const needle = normalise(quote);
    const cited = fetched.find(({ body }) => normalise(body).includes(needle));
    if (!cited) {
      // The cascade never emits a citation it has not itself verified.
      console.error(
        `discarded an unverifiable quote for "${question}": ${JSON.stringify(quote.slice(0, 80))}` +
          ` is not in ${fetched.map(({ hit }) => hit.id).join(", ")} — escalating to a human`,
      );
      return escalate();
    }
    return {
      rung: "knowledge_base",
      grounding: [
        {
          source: sourceOf(cited.hit.id),
          docId: cited.hit.id,
          title: cited.hit.title ?? cited.hit.id,
          url: cited.hit.url ?? null,
          quote,
          retrievedAt: new Date().toISOString(),
          traceId: payload.trace_id ?? null,
          // [G] — the assembler recomputes this from HEDGE_LEXICON; it is
          // written false rather than omitted only to satisfy the schema type.
          hedged: false,
        },
      ],
      answer: quote,
      confidence,
    };
  } catch (err: any) {
    // A knowledge plane that throws must not take the pipeline down, and must
    // not be rewarded with a pass either: unresolved is unresolved, so this is
    // an escalation to a named human, with the cause on stderr where it cannot
    // be mistaken for an answer.
    console.error(`grounding failed: ${String(err?.message ?? err).split("\n")[0]} — escalating`);
    return escalate();
  }
}

function defaultSearch(client: Db, viewer: Viewer): SearchFn {
  return async (query: string) => {
    // Lazily imported, matching io.ts and the CLI: this module stays cheap for
    // callers that only want the local rungs.
    const { callTool } = await import("../tools.js");
    const res = await callTool("search_docs", { query, limit: SEARCH_LIMIT }, viewer, client);
    return res as SearchDocsPayload;
  };
}

/**
 * The default judge: one bounded model call, structured reply, no autonomy over
 * anything but answerhood. `quote` is verified by the caller, so a fabricated
 * one costs a wasted call and nothing else.
 */
export function makeJudge(opts: { client?: Db; provider?: string; caller?: string } = {}): JudgeFn {
  return async (question: string, docs: JudgeDoc[]): Promise<Judgment> => {
    const { getProvider, logCall, parseJsonReply } = await import("../llm/index.js");
    const corpus = docs
      .map((d) => `--- document ${d.docId} — ${d.title} ---\n${d.body}`)
      .join("\n\n");
    const prompt = `${JUDGE_INSTRUCTIONS}\n\nQUESTION\n${question}\n\nDOCUMENTS\n${corpus}\n`;
    const provider = getProvider(opts.provider);
    const result = await provider.complete(prompt, { maxTokens: 512 });
    if (opts.client) {
      try {
        await logCall(opts.client, opts.caller ?? "reqs/ground", result);
      } catch (err: any) {
        // Bookkeeping never masks the outcome of the call it is recording.
        console.error(`llm_calls insert skipped: ${err.message}`);
      }
    }
    const reply = parseJsonReply(result.text);
    return {
      answers: reply.answers === true,
      quote: typeof reply.quote === "string" ? reply.quote : "",
      rationale: typeof reply.rationale === "string" ? reply.rationale : "",
    };
  };
}

/**
 * Aboutness vs answerhood, said to the model in the same words the module is
 * built around — with PTR-420's failure mode named explicitly, because that is
 * the mistake being asked for.
 */
const JUDGE_INSTRUCTIONS = `You decide ONE thing: do the documents below ANSWER the question?

Being ABOUT the question is not ANSWERING it. A document that restates the
question, records that a decision is still open, or says the matter is undecided
does NOT answer it — reply answers: false for those.

Reply with JSON only:
  {"answers": boolean, "quote": string, "rationale": string}

- quote: the shortest run of text that carries the answer, copied from ONE
  document CHARACTER FOR CHARACTER. Empty string when answers is false. The
  quote is checked against the document it came from and discarded if it is not
  found there, so do not paraphrase, summarise, or stitch two passages together.
- rationale: one sentence.`;

/**
 * Walk the cascade and return the first rung that answers, or rung 5.
 *
 * Either inject `search`/`fetchDoc` (tests, alternative knowledge planes) or
 * pass `client` and `viewer` and let the defaults go through `callTool` — which
 * is what keeps the ACL viewer and the audit trail on every read.
 */
export async function resolveUnknown(question: string, deps: ResolveDeps): Promise<Resolution> {
  const local = await tryLocal(question, deps.repoRoot);
  if (local) return local;

  let { search, fetchDoc } = deps;
  if (!search || !fetchDoc) {
    const { client, viewer } = deps;
    if (!client || !viewer) {
      throw new Error(
        "resolveUnknown needs either an injected search/fetchDoc pair or a client and viewer",
      );
    }
    search ??= defaultSearch(client, viewer);
    // The one resolver: it inherits the caller's ACL viewer and reassembles
    // windowed bodies, so a quote can be verified wherever in the document it
    // sits — and a document this viewer may not read verifies as unresolvable
    // rather than against text they were never entitled to see.
    fetchDoc ??= makeDocResolver(client, viewer);
  }
  const judge = deps.judge ?? makeJudge(deps.client ? { client: deps.client } : {});
  return tryKnowledgeBase(question, search, fetchDoc, judge);
}
