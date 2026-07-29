/**
 * Retrieval metrics. Small enough to live in vitest and CI rather than behind a
 * Python dependency, which is the point: a metric you cannot run in the test
 * suite is a metric that stops being run.
 *
 * Conventions chosen to match `trec_eval` so the numbers are comparable to
 * published work and so a future cross-check is meaningful:
 *   - ranks are 1-based; discount is log2(rank + 1)
 *   - nDCG uses LINEAR gain (gain = grade), not 2^grade - 1. Both are defensible
 *     and widely used; trec_eval's `ndcg` uses linear, so we do too. Mixing the
 *     two silently changes every number by a few points.
 *   - a document with no qrel entry is treated as grade 0 (unjudged = not
 *     relevant), which is standard and is exactly why judged@k must be reported
 *     alongside: it is the number that says whether that assumption is safe.
 */

/** doc_id -> graded relevance, 0..3. Absent means unjudged, scored as 0. */
export type Qrels = ReadonlyMap<string, number>;

const gradeOf = (qrels: Qrels, id: string): number => qrels.get(id) ?? 0;

/** A document counts as relevant at or above this grade. */
export const RELEVANT_AT = 1;

/**
 * Fraction of all known-relevant documents that appear in the top k.
 *
 * Recall@50 and Recall@10 are reported as a PAIR: the first is headroom, moved
 * by the embedder / BM25 / chunker, the second is what was delivered, moved by
 * fusion and reranking. The gap between them is the maximum a reranker could
 * ever buy — measure it before spending anything on one.
 */
export function recallAt(ranked: readonly string[], qrels: Qrels, k: number): number {
  let total = 0;
  for (const g of qrels.values()) if (g >= RELEVANT_AT) total += 1;
  if (total === 0) return Number.NaN; // no relevant docs: undefined, not 1.0
  let hit = 0;
  for (const id of ranked.slice(0, k)) if (gradeOf(qrels, id) >= RELEVANT_AT) hit += 1;
  return hit / total;
}

export function precisionAt(ranked: readonly string[], qrels: Qrels, k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  let hit = 0;
  for (const id of top) if (gradeOf(qrels, id) >= RELEVANT_AT) hit += 1;
  return hit / top.length;
}

export function dcgAt(ranked: readonly string[], qrels: Qrels, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    dcg += gradeOf(qrels, id) / Math.log2(i + 2); // i is 0-based, rank = i+1
  });
  return dcg;
}

/**
 * nDCG@k. The ideal ranking is every judgment sorted by grade descending —
 * including relevant documents the system did not return, which is what makes
 * this an absolute score rather than a self-grading one.
 */
export function ndcgAt(ranked: readonly string[], qrels: Qrels, k: number): number {
  const ideal = [...qrels.values()].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((g, i) => {
    idcg += g / Math.log2(i + 2);
  });
  if (idcg === 0) return Number.NaN; // nothing relevant to rank: undefined
  return dcgAt(ranked, qrels, k) / idcg;
}

/** Reciprocal rank of the first relevant result; 0 if none in the list. */
export function reciprocalRank(ranked: readonly string[], qrels: Qrels): number {
  for (let i = 0; i < ranked.length; i++) {
    if (gradeOf(qrels, ranked[i]!) >= RELEVANT_AT) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Fraction of the top k that carries ANY judgment.
 *
 * This is the trust gauge for every other number here. Because unjudged is
 * scored as not-relevant, a run whose results were never in the judging pool is
 * penalised for retrieving things nobody looked at. Below ~0.8 the scores are
 * not comparable and the pool needs topping up.
 */
export function judgedAt(ranked: readonly string[], qrels: Qrels, k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return Number.NaN;
  let judged = 0;
  for (const id of top) if (qrels.has(id)) judged += 1;
  return judged / top.length;
}

/**
 * Rank-biased overlap: how similar two rankings are, weighted toward the top.
 * `p` sets the weight decay — 0.9 puts ~86% of the weight in the first 10.
 *
 * This is the drift alarm, and EIL can use it where most systems cannot: ANN
 * nondeterminism and LLM rerankers make exact-list comparison flap, so teams
 * give up on it. A deterministic retriever gives RBO exactly 1.000 for a clean
 * refactor, which turns "did anything move?" into a yes/no rather than a vibe.
 *
 * Truncated (no extrapolation past the shorter list — never credit agreement we
 * did not observe), then NORMALISED by the maximum achievable at that depth,
 * `1 - p^depth`.
 *
 * The normalisation is not cosmetic. Raw truncated RBO of two IDENTICAL depth-3
 * lists is 0.271, because the weight beyond depth 3 is simply unaccounted for.
 * As a drift alarm that is unusable: "nothing changed" has to read 1.000, or
 * every comparison needs a depth-dependent reference value to interpret.
 */
export function rbo(a: readonly string[], b: readonly string[], p = 0.9): number {
  const depth = Math.min(a.length, b.length);
  if (depth === 0) return a.length === b.length ? 1 : 0;
  const seenA = new Set<string>();
  const seenB = new Set<string>();
  let overlap = 0;
  let sum = 0;
  for (let d = 0; d < depth; d++) {
    const x = a[d]!;
    const y = b[d]!;
    seenA.add(x);
    seenB.add(y);
    // Intersection growth at this depth. The same-item case is handled first,
    // because otherwise both membership tests fire and it is counted twice.
    if (x === y) overlap += 1;
    else {
      if (seenB.has(x)) overlap += 1;
      if (seenA.has(y)) overlap += 1;
    }
    sum += (overlap / (d + 1)) * p ** d;
  }
  const maxAtDepth = 1 - p ** depth; // == (1-p) * sum(p^d, d=0..depth-1)
  return ((1 - p) * sum) / maxAtDepth;
}

export interface QueryScore {
  recall10: number;
  recall50: number;
  ndcg10: number;
  mrr: number;
  judged10: number;
}

export function scoreQuery(ranked: readonly string[], qrels: Qrels): QueryScore {
  return {
    recall10: recallAt(ranked, qrels, 10),
    recall50: recallAt(ranked, qrels, 50),
    ndcg10: ndcgAt(ranked, qrels, 10),
    mrr: reciprocalRank(ranked, qrels),
    judged10: judgedAt(ranked, qrels, 10),
  };
}

/** Mean over queries, skipping NaN (queries with no relevant documents). */
export function mean(xs: readonly number[]): number {
  const ok = xs.filter((x) => !Number.isNaN(x));
  return ok.length === 0 ? Number.NaN : ok.reduce((a, b) => a + b, 0) / ok.length;
}

/**
 * Paired permutation test: is the difference between two systems real?
 *
 * Measurably better-behaved than bootstrap, Wilcoxon or sign tests for IR
 * evaluation (Urbano et al.); bootstrap in particular has inflated false
 * positives at small n, which is exactly the regime a 150-query set lives in.
 *
 * Under the null hypothesis the two systems are interchangeable, so for each
 * query the observed pair could equally have come out either way. Shuffling the
 * signs builds the null distribution directly, with no distributional
 * assumption. Deterministic by default: an eval that reports a different
 * p-value each run is not a gate.
 */
export function pairedPermutationTest(
  a: readonly number[],
  b: readonly number[],
  iterations = 10_000,
  seed = 12345,
): { meanDelta: number; p: number } {
  if (a.length !== b.length) throw new Error("paired test needs equal-length samples");
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]!) || Number.isNaN(b[i]!)) continue;
    diffs.push(b[i]! - a[i]!);
  }
  const n = diffs.length;
  if (n === 0) return { meanDelta: Number.NaN, p: Number.NaN };
  const observed = diffs.reduce((s, d) => s + d, 0) / n;

  // xorshift32, so the p-value is reproducible across runs and machines.
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };

  let atLeastAsExtreme = 0;
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (const d of diffs) sum += next() < 0.5 ? -d : d;
    if (Math.abs(sum / n) >= Math.abs(observed)) atLeastAsExtreme += 1;
  }
  // +1 smoothing: a p of exactly 0 is not a claim any finite sample supports.
  return { meanDelta: observed, p: (atLeastAsExtreme + 1) / (iterations + 1) };
}
