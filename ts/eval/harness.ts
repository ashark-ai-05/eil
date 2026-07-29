/**
 * The evaluation harness.
 *
 * Two properties matter more than the metrics themselves:
 *
 * 1. It runs the PRODUCTION path — searchDocs, not a reimplementation. A harness
 *    that reimplements retrieval measures the harness.
 * 2. The labelled set bootstraps by REPLAY. docs/golden-queries.md asked for
 *    entries "from actual usage" and sat at two for its lifetime, because
 *    nothing produced usable usage records. Step 0 fixed that: audit_log now
 *    carries real queries with route, executor and duration, so `mineQueries`
 *    turns traffic into a candidate set instead of asking someone to invent one.
 */

import type { Db } from "../db.js";
import { type Viewer, searchDocs } from "../search.js";
import { type Qrels, type QueryScore, mean, scoreQuery } from "./metrics.js";

export type Origin = "logged" | "authored" | "synthetic";

export interface EvalQuery {
  id: number;
  query: string;
  origin: Origin;
}

/** Retrieval depth. 50 so Recall@50 is measurable — it is the headroom number,
 *  and its gap to Recall@10 bounds what a reranker could ever buy. */
export const EVAL_DEPTH = 50;

/**
 * Promote distinct real queries out of audit_log into the labelled set.
 *
 * Only successful search calls: a failed or denied call says nothing about
 * ranking. Queries arrive UNJUDGED — mining creates the question, a human or a
 * judge still has to answer it.
 */
export async function mineQueries(
  client: Db,
  opts: { limit?: number; minLength?: number; tenant?: string } = {},
): Promise<number> {
  const limit = opts.limit ?? 200;
  const minLength = opts.minLength ?? 8;
  const tenant = opts.tenant ?? "default";
  const rows = await client.query(
    `SELECT args->>'query' AS q, count(*)::int AS n
       FROM audit_log
      WHERE tool IN ('search_docs', 'search_code')
        AND ok IS TRUE
        AND tenant = $1
        AND length(coalesce(args->>'query', '')) >= $2
      GROUP BY 1
      ORDER BY n DESC, q
      LIMIT $3`,
    [tenant, minLength, limit],
  );
  let added = 0;
  for (const row of rows.rows) {
    const res = await client.query(
      "INSERT INTO eval_queries (query, tenant, origin, note) VALUES ($1, $2, 'logged', $3)" +
        " ON CONFLICT (tenant, query) DO NOTHING RETURNING id",
      [row.q, tenant, `seen ${row.n}x in audit_log`],
    );
    if (res.rows.length > 0) added += 1;
  }
  return added;
}

async function loadQrels(client: Db, queryId: number): Promise<Qrels> {
  const res = await client.query("SELECT doc_id, grade FROM eval_qrels WHERE query_id = $1", [
    queryId,
  ]);
  return new Map(res.rows.map((r: any) => [r.doc_id as string, Number(r.grade)]));
}

export interface RunResult {
  runId: number | null;
  queries: number;
  judged: number;
  mix: Record<Origin, number>;
  recall10: number;
  recall50: number;
  ndcg10: number;
  mrr: number;
  judged10: number;
  perQuery: Array<{ query: EvalQuery; score: QueryScore; ranked: string[]; judged: boolean }>;
}

/**
 * Run every labelled query through the production retriever and score it.
 *
 * Queries with no qrels are executed but excluded from the aggregate — running
 * them is what fills the judging pool for the next round, which is how a pooled
 * collection becomes incrementally reusable rather than needing a full re-judge
 * per system.
 */
export async function runEval(
  client: Db,
  viewer: Viewer,
  opts: { gitSha?: string; persist?: boolean } = {},
): Promise<RunResult> {
  const qs = await client.query(
    "SELECT id, query, origin FROM eval_queries WHERE tenant = $1 ORDER BY id",
    [viewer.tenant],
  );
  const perQuery: RunResult["perQuery"] = [];
  const mix: Record<Origin, number> = { logged: 0, authored: 0, synthetic: 0 };

  for (const row of qs.rows) {
    const q: EvalQuery = { id: Number(row.id), query: row.query, origin: row.origin };
    mix[q.origin] += 1;
    const res: any = await searchDocs(client, viewer, q.query, EVAL_DEPTH);
    // The entity route answers with `entity`+`linked` rather than `results`;
    // normalise so a route change cannot silently zero the score.
    const ranked: string[] = Array.isArray(res.results)
      ? res.results.map((r: any) => r.id ?? r.docId).filter(Boolean)
      : res.entity?.id
        ? [res.entity.id]
        : [];
    const qrels = await loadQrels(client, q.id);
    perQuery.push({ query: q, score: scoreQuery(ranked, qrels), ranked, judged: qrels.size > 0 });
  }

  // Unjudged queries still RAN — that is what fills the pool for the next round
  // of judging — but they cannot contribute a score, so they are excluded from
  // the aggregate rather than counted as zeroes.
  const scored = perQuery.filter((p) => p.judged);

  const out: RunResult = {
    runId: null,
    queries: perQuery.length,
    judged: scored.length,
    mix,
    recall10: mean(scored.map((p) => p.score.recall10)),
    recall50: mean(scored.map((p) => p.score.recall50)),
    ndcg10: mean(scored.map((p) => p.score.ndcg10)),
    mrr: mean(scored.map((p) => p.score.mrr)),
    judged10: mean(scored.map((p) => p.score.judged10)),
    perQuery,
  };

  if (opts.persist && scored.length > 0) {
    const misses = scored
      .filter((p) => p.score.recall10 === 0)
      .map((p) => ({ query: p.query.query, origin: p.query.origin }));
    const run = await client.query(
      "INSERT INTO metrics.eval_runs (git_sha, k, queries, mean_recall, misses)" +
        " VALUES ($1, $2, $3, $4, $5) RETURNING id",
      // k=10 keeps mean_recall comparable with the pre-existing trend, which was
      // always recall@10; the richer per-query metrics live in eval_query_results.
      [
        opts.gitSha ?? "unknown",
        10,
        scored.length,
        out.recall10.toFixed(4),
        JSON.stringify(misses),
      ],
    );
    out.runId = Number(run.rows[0].id);
    for (const p of scored) {
      await client.query(
        "INSERT INTO metrics.eval_query_results" +
          " (run_id, query_id, recall_10, recall_50, ndcg_10, mrr, judged_10, returned)" +
          " VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          out.runId,
          p.query.id,
          fixed(p.score.recall10),
          fixed(p.score.recall50),
          fixed(p.score.ndcg10),
          fixed(p.score.mrr),
          fixed(p.score.judged10),
          JSON.stringify(p.ranked.slice(0, EVAL_DEPTH)),
        ],
      );
    }
  }
  return out;
}

const fixed = (n: number): string | null => (Number.isNaN(n) ? null : n.toFixed(4));

export const EVAL_METRICS = ["ndcg_10", "recall_10", "recall_50", "mrr"] as const;
export type EvalMetric = (typeof EVAL_METRICS)[number];

/**
 * Compare two stored runs query-by-query.
 *
 * Paired, because the alternative — comparing two means — throws away the fact
 * that both systems answered the SAME queries, which is most of the statistical
 * power available at n=150.
 */
export async function compareRuns(
  client: Db,
  baselineRunId: number,
  candidateRunId: number,
  metric: EvalMetric = "ndcg_10",
): Promise<{ a: number[]; b: number[]; queryIds: number[] }> {
  // Whitelisted rather than trusted: `metric` reaches SQL text as an identifier,
  // so a union type alone is a compile-time guarantee that a JS caller can defeat.
  if (!EVAL_METRICS.includes(metric)) throw new Error(`unknown eval metric: ${metric}`);
  const res = await client.query(
    `SELECT base.query_id, base.${metric} AS a, cand.${metric} AS b
       FROM metrics.eval_query_results base
       JOIN metrics.eval_query_results cand USING (query_id)
      WHERE base.run_id = $1 AND cand.run_id = $2
      ORDER BY base.query_id`,
    [baselineRunId, candidateRunId],
  );
  return {
    queryIds: res.rows.map((r: any) => Number(r.query_id)),
    a: res.rows.map((r: any) => (r.a === null ? Number.NaN : Number(r.a))),
    b: res.rows.map((r: any) => (r.b === null ? Number.NaN : Number(r.b))),
  };
}
