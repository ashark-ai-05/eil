/**
 * What the two-phase contract actually saves, measured rather than asserted.
 *
 * The claim under test is the one an executive will be asked to fund: that an
 * agent talking to this never pays a model to read documents it did not need.
 * The honest way to show it is to count characters that really would have
 * crossed into a model's context, from the real corpus, for a real query.
 *
 * Two figures, both serialized exactly as a tool result is serialized, so they
 * are like for like:
 *
 *   pass-through  every matched document returned in full, which is what a
 *                 connector that answers a search with page bodies puts in
 *                 front of the model
 *   two-phase     the search_docs payload (ids, titles, snippets) plus the
 *                 get_doc payload for the documents the agent actually opened
 *
 * Neither number is modelled or estimated. The only assumption is how many
 * documents the agent opens, which is a parameter and is printed alongside the
 * result, because an assumption you cannot see is not one the room can check.
 */

import { type Db, connect } from "./db.js";
import { GET_DOC_MAX_CHARS, type Viewer, getDoc, localViewer, searchDocs } from "./search.js";

/** Rule of thumb, not a tokenizer. Reported as approximate wherever it is shown. */
export const CHARS_PER_TOKEN = 4;

export interface ContextCostReport {
  query: string;
  /** Documents the search returned — the set a pass-through would have to send. */
  matched: number;
  /** Documents assumed opened. Stated, not hidden. */
  fetched: number;
  passthroughChars: number;
  phase1Chars: number;
  phase2Chars: number;
  twoPhaseChars: number;
  /** passthrough / two-phase. Null when nothing matched. */
  ratio: number | null;
  /**
   * Cost of ONE more match, each way. This is the figure that travels.
   *
   * The headline ratio is partly an artefact of the corpus: it climbs as more
   * documents match, because the one document the agent opens is a fixed cost
   * that amortises. Measured here it went 1.5x at four matches to 4.9x at
   * nineteen, on the same query and the same index.
   *
   * The per-document pair does not move — a match costs a whole body one way
   * and a snippet the other, whatever else is going on — so it is the honest
   * thing to quote to someone asking what this would do on THEIR corpus, where
   * pages are larger and more of them match.
   */
  passthroughPerDoc: number | null;
  snippetPerDoc: number | null;
  /**
   * Matched documents longer than one get_doc window.
   *
   * These are the ones where the pass-through figure is a floor rather than a
   * ceiling: a connector with no windowing sends the whole body, and the
   * longer the document the further apart the two numbers get. Counting them
   * keeps the comparison from looking better than it is by accident.
   */
  windowedDocs: number;
  /** Set when the query bypassed the arms, so there is no result set to compare. */
  note?: string;
}

const jsonChars = (value: unknown): number => JSON.stringify(value ?? null).length;

export const approxTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/**
 * Measure one query.
 *
 * `fetched` is how many of the ranked results the agent is assumed to open,
 * top-down. One is the common case and the default; passing more moves the
 * two-phase figure towards the pass-through figure, which is the honest way to
 * show where the argument stops holding.
 */
export async function measureContextCost(
  client: Db,
  viewer: Viewer,
  query: string,
  limit = 8,
  fetched = 1,
): Promise<ContextCostReport> {
  const phase1 = await searchDocs(client, viewer, query, limit);
  const results = Array.isArray(phase1.results) ? (phase1.results as Array<{ id: string }>) : null;

  if (results === null) {
    // A ticket key routes straight to the entity and answers in one call. That
    // is cheaper still, but it is not the thing this measures, and quietly
    // reporting a ratio for it would be comparing two different mechanisms.
    return {
      query,
      matched: 0,
      fetched: 0,
      passthroughChars: jsonChars(phase1),
      phase1Chars: jsonChars(phase1),
      phase2Chars: 0,
      twoPhaseChars: jsonChars(phase1),
      ratio: null,
      passthroughPerDoc: null,
      snippetPerDoc: null,
      windowedDocs: 0,
      note: `"${query}" routed to ${String(phase1.route)} and answered without a result set`,
    };
  }

  // Pass-through: every matched document, whole, in the shape get_doc returns —
  // so the comparison is between two payloads of the same kind and not between
  // a JSON envelope and a bare string.
  let passthroughChars = 0;
  let windowedDocs = 0;
  for (const r of results) {
    const whole = await getDoc(client, viewer, r.id, 0, Number.MAX_SAFE_INTEGER);
    if (whole === null) continue; // ACL-invisible between the two reads; skip rather than guess
    passthroughChars += jsonChars(whole);
    if (String(whole.body ?? "").length > GET_DOC_MAX_CHARS) windowedDocs += 1;
  }

  // Two-phase: the search payload, plus a real get_doc for each document opened.
  const opened = results.slice(0, Math.max(0, fetched));
  let phase2Chars = 0;
  for (const r of opened) {
    phase2Chars += jsonChars(await getDoc(client, viewer, r.id, 0));
  }

  const phase1Chars = jsonChars(phase1);
  const twoPhaseChars = phase1Chars + phase2Chars;
  return {
    query,
    matched: results.length,
    fetched: opened.length,
    passthroughChars,
    phase1Chars,
    phase2Chars,
    twoPhaseChars,
    ratio: twoPhaseChars === 0 ? null : passthroughChars / twoPhaseChars,
    passthroughPerDoc: results.length === 0 ? null : Math.round(passthroughChars / results.length),
    snippetPerDoc: results.length === 0 ? null : Math.round(phase1Chars / results.length),
    windowedDocs,
  };
}

/** Human-readable, for the CLI and for reading aloud. */
export function formatContextCost(report: ContextCostReport): string {
  const n = (x: number) => x.toLocaleString("en-GB");
  const lines: string[] = [`query: ${report.query}`];

  if (report.note) {
    lines.push(`  ${report.note}`);
    return lines.join("\n");
  }

  lines.push(
    `  matched ${report.matched} document(s); agent opened ${report.fetched}`,
    "",
    `  pass-through   ${n(report.passthroughChars).padStart(10)} chars  ` +
      `(~${n(approxTokens(report.passthroughChars))} tokens)  every match, in full`,
    `  two-phase      ${n(report.twoPhaseChars).padStart(10)} chars  ` +
      `(~${n(approxTokens(report.twoPhaseChars))} tokens)  ` +
      `${n(report.phase1Chars)} search + ${n(report.phase2Chars)} fetch`,
  );

  if (report.ratio !== null) {
    lines.push("", `  ${report.ratio.toFixed(1)}x less context for the same answer.`);
  }
  if (report.passthroughPerDoc !== null && report.snippetPerDoc !== null) {
    // The figure to quote at someone asking about their own corpus. The ratio
    // above moves with how many documents matched; this pair does not.
    lines.push(
      `  Per match: ${n(report.passthroughPerDoc)} chars sent in full, ` +
        `vs ${n(report.snippetPerDoc)} as a snippet.`,
    );
  }
  if (report.windowedDocs > 0) {
    lines.push(
      `  ${report.windowedDocs} matched document(s) exceed one get_doc window, so the`,
      "  pass-through figure is a floor: an unwindowed connector sends more.",
    );
  }
  lines.push("", "  Token counts are chars/4 — a rule of thumb, not a tokenizer.");
  return lines.join("\n");
}

/** CLI entry point: measure one or more queries against the local catalog. */
export async function runContextCost(
  queries: string[],
  limit: number,
  fetched: number,
): Promise<ContextCostReport[]> {
  const client = await connect();
  try {
    const viewer = localViewer();
    const out: ContextCostReport[] = [];
    for (const query of queries) {
      out.push(await measureContextCost(client, viewer, query, limit, fetched));
    }
    return out;
  } finally {
    await client.end();
  }
}
