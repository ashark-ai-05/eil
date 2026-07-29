/**
 * The judging loop — turning mined queries into a labelled set.
 *
 * `eval:mine` produces the QUESTIONS; without this, answering them means writing
 * INSERT statements by hand. That friction is not incidental: it is why
 * docs/golden-queries.md asked for entries "from actual usage" and held two for
 * its entire life. A labelled set that is tedious to extend does not get
 * extended.
 *
 * Pooled by construction. Each run contributes its top-K to a shared pool, every
 * (query, document) pair is judged once, and later runs reuse those judgments —
 * so the collection becomes incrementally reusable instead of needing a full
 * re-judge per system. `judged@k` then tells you whether the pool is deep enough
 * for the scores to mean anything.
 */

import type { Db } from "../db.js";
import type { Provider } from "../llm/index.js";
import { type Viewer, searchDocs } from "../search.js";

export interface PoolItem {
  queryId: number;
  query: string;
  docId: string;
  title: string;
  snippet: string;
}

export interface Judgment {
  queryId: number;
  docId: string;
  grade: number;
}

/** Grade meanings, kept with the code that writes them so a later judge — human
 *  or model — applies the same scale as the first one. Graded rather than
 *  binary: pointwise grading is immune to the position bias that flips 10-30%
 *  of pairwise verdicts on reordering, and is O(pool) rather than O(pairs). */
export const GRADE_SCALE = [
  "0 — irrelevant: does not help answer the query",
  "1 — related: same topic, does not answer it",
  "2 — helpful: contains part of the answer",
  "3 — answers: a reader would stop here",
] as const;

/**
 * Everything retrieved for a labelled query that nobody has judged yet.
 *
 * Runs the production retriever, so the pool reflects what the system actually
 * returns rather than what someone imagined it would.
 */
export async function buildPool(client: Db, viewer: Viewer, depth = 20): Promise<PoolItem[]> {
  const qs = await client.query(
    "SELECT id, query FROM eval_queries WHERE tenant = $1 ORDER BY id",
    [viewer.tenant],
  );
  const pool: PoolItem[] = [];
  for (const row of qs.rows) {
    const queryId = Number(row.id);
    const res: any = await searchDocs(client, viewer, row.query, depth);
    const results: any[] = Array.isArray(res.results)
      ? res.results
      : res.entity
        ? [{ id: res.entity.id, title: res.entity.title, snippet: "" }]
        : [];
    const judged = await client.query("SELECT doc_id FROM eval_qrels WHERE query_id = $1", [
      queryId,
    ]);
    const already = new Set(judged.rows.map((r: any) => r.doc_id as string));
    for (const r of results) {
      const docId = r.id ?? r.docId;
      if (!docId || already.has(docId)) continue;
      already.add(docId); // a doc can surface twice across arms; judge it once
      pool.push({
        queryId,
        query: row.query,
        docId,
        title: r.title ?? "",
        snippet: String(r.snippet ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 300),
      });
    }
  }
  return pool;
}

const MARKER = "<!-- eil-judgments v1 -->";

/**
 * A human-editable worksheet. Markdown rather than CSV or JSON because the
 * judge needs to READ the snippet to grade it, and because a diff of a
 * judgment file should be reviewable.
 */
export function exportPool(pool: PoolItem[]): string {
  const byQuery = new Map<number, PoolItem[]>();
  for (const p of pool) {
    const list = byQuery.get(p.queryId) ?? [];
    list.push(p);
    byQuery.set(p.queryId, list);
  }
  const out: string[] = [
    MARKER,
    "",
    "# Relevance judgments",
    "",
    // Deliberately does NOT contain the literal placeholder token. It used to,
    // which meant a find-replace over the file — by sed, by an editor, by a
    // script — silently edited the instructions instead of the first entry.
    "Set each grade below to a number 0-3, then re-import. Leave a placeholder",
    "untouched to skip that pair; it stays in the pool for next time.",
    "",
    ...GRADE_SCALE.map((g) => `- ${g}`),
    "",
  ];
  for (const [queryId, items] of byQuery) {
    out.push(`## [${queryId}] ${items[0]!.query}`, "");
    for (const it of items) {
      out.push(`- doc: \`${it.docId}\``);
      out.push(`  title: ${it.title || "(untitled)"}`);
      if (it.snippet) out.push(`  snippet: ${it.snippet}`);
      out.push("  grade: ?", "");
    }
  }
  return out.join("\n");
}

/** Parse a worksheet back. Unfilled (`?`) entries are skipped, not defaulted —
 *  guessing a grade would silently poison the collection. */
export function parseJudgments(markdown: string): Judgment[] {
  if (!markdown.includes(MARKER)) {
    throw new Error("not an eil judgments file (missing header marker)");
  }
  const out: Judgment[] = [];
  let queryId: number | null = null;
  let docId: string | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const head = /^##\s*\[(\d+)\]/.exec(line);
    if (head) {
      queryId = Number(head[1]);
      docId = null;
      continue;
    }
    const doc = /^-\s*doc:\s*`([^`]+)`/.exec(line);
    if (doc) {
      docId = doc[1]!;
      continue;
    }
    const grade = /^grade:\s*([0-3])\s*$/.exec(line);
    if (grade && queryId !== null && docId !== null) {
      out.push({ queryId, docId, grade: Number(grade[1]) });
      docId = null;
    }
  }
  return out;
}

export async function applyJudgments(
  client: Db,
  judgments: Judgment[],
  judgedBy: string,
): Promise<number> {
  let n = 0;
  for (const j of judgments) {
    const res = await client.query(
      "INSERT INTO eval_qrels (query_id, doc_id, grade, judged_by) VALUES ($1, $2, $3, $4)" +
        " ON CONFLICT (query_id, doc_id) DO NOTHING RETURNING doc_id",
      [j.queryId, j.docId, j.grade, judgedBy],
    );
    if (res.rows.length > 0) n += 1;
  }
  return n;
}

/**
 * UMBRELA-style pointwise prompt.
 *
 * The honest case for a model judge: per-label agreement with humans is only
 * mediocre (Cohen's kappa 0.35-0.50), but agreement on SYSTEM RANKING is strong
 * (Kendall tau 0.89-0.94) — and "is config B better than A" is the only question
 * this collection is ever asked. Worth knowing the counterpart finding too: in
 * TREC 2024 RAG an independent human agreed better with GPT-4o than with the
 * original human assessor, so human labels are not a stable gold standard
 * either.
 */
export function judgePrompt(query: string, title: string, snippet: string): string {
  return [
    "You are assessing whether a document is relevant to a search query.",
    "",
    `Query: ${query}`,
    `Document title: ${title || "(untitled)"}`,
    `Document excerpt: ${snippet || "(no excerpt)"}`,
    "",
    "Grade the document on this scale:",
    ...GRADE_SCALE,
    "",
    'Reply with JSON only: {"grade": <0-3>}',
  ].join("\n");
}

/**
 * Grade a pool with a model. Failures skip the pair rather than defaulting it —
 * an unjudged pair is honest and stays in the pool; a wrong one is permanent and
 * invisible.
 */
export async function judgeWithLlm(
  pool: PoolItem[],
  provider: Provider,
  onProgress?: (done: number, total: number) => void,
): Promise<{ judgments: Judgment[]; failed: number }> {
  const { parseJsonReply } = await import("../llm/index.js");
  const judgments: Judgment[] = [];
  let failed = 0;
  for (const [i, item] of pool.entries()) {
    try {
      const res = await provider.complete(judgePrompt(item.query, item.title, item.snippet), {
        maxTokens: 32,
      });
      const grade = Number(parseJsonReply(res.text).grade);
      if (!Number.isInteger(grade) || grade < 0 || grade > 3) throw new Error(`bad grade ${grade}`);
      judgments.push({ queryId: item.queryId, docId: item.docId, grade });
    } catch {
      failed += 1;
    }
    onProgress?.(i + 1, pool.length);
  }
  return { judgments, failed };
}
