/**
 * Every expected value here is computed BY HAND from the definition, not from a
 * previous run of this code. A metric suite that only agrees with itself is a
 * consistency check, not a correctness check — and these numbers gate every
 * ranking change in the plan.
 */
import { describe, expect, it } from "vitest";
import {
  dcgAt,
  judgedAt,
  mean,
  ndcgAt,
  pairedPermutationTest,
  precisionAt,
  rbo,
  recallAt,
  reciprocalRank,
} from "../eval/metrics.js";

const q = (o: Record<string, number>) => new Map(Object.entries(o));

describe("recall@k", () => {
  it("is hits-in-top-k over ALL relevant, not over k", () => {
    const qrels = q({ a: 1, b: 1, c: 1, d: 0 }); // 3 relevant
    expect(recallAt(["a", "d", "b"], qrels, 10)).toBeCloseTo(2 / 3, 10);
    expect(recallAt(["a", "d", "b"], qrels, 1)).toBeCloseTo(1 / 3, 10);
  });
  it("counts an unjudged document as not relevant", () => {
    expect(recallAt(["zzz"], q({ a: 1 }), 10)).toBe(0);
  });
  it("is undefined, not 1.0, when nothing is relevant", () => {
    expect(Number.isNaN(recallAt(["a"], q({ a: 0 }), 10))).toBe(true);
  });
});

describe("precision@k", () => {
  it("divides by the returned count, not k, on a short list", () => {
    expect(precisionAt(["a", "b"], q({ a: 1, b: 0 }), 10)).toBeCloseTo(0.5, 10);
  });
});

describe("DCG / nDCG", () => {
  // grades 3,2,3,0 at ranks 1..4 with discount log2(rank+1):
  //   3/1 + 2/1.5849625007 + 3/2 + 0 = 3 + 1.2618595071 + 1.5 = 5.7618595071
  it("matches a hand-computed DCG", () => {
    const qrels = q({ a: 3, b: 2, c: 3, d: 0 });
    expect(dcgAt(["a", "b", "c", "d"], qrels, 10)).toBeCloseTo(5.7618595071, 8);
  });

  // ideal order is 3,3,2,0 -> 3 + 3/1.5849625007 + 2/2 = 3 + 1.8927892607 + 1
  //   = 5.8927892607 ; nDCG = 5.7618595071 / 5.8927892607 = 0.97778...
  it("matches a hand-computed nDCG against the ideal ordering", () => {
    const qrels = q({ a: 3, b: 2, c: 3, d: 0 });
    expect(ndcgAt(["a", "b", "c", "d"], qrels, 10)).toBeCloseTo(0.9777813616, 9);
  });

  it("is 1.0 exactly for the ideal ranking", () => {
    const qrels = q({ a: 3, b: 2, c: 1 });
    expect(ndcgAt(["a", "b", "c"], qrels, 10)).toBeCloseTo(1, 10);
  });

  // The whole reason nDCG is here rather than recall alone: recall cannot see
  // this, and ordering is exactly what the ranking work changes.
  it("SEES a reordering that recall@10 is blind to", () => {
    const qrels = q({ good: 3, filler1: 0, filler2: 0, filler3: 0 });
    const first = ["good", "filler1", "filler2", "filler3"];
    const last = ["filler1", "filler2", "filler3", "good"];
    expect(recallAt(first, qrels, 10)).toBe(recallAt(last, qrels, 10)); // blind
    expect(ndcgAt(first, qrels, 10)).toBeGreaterThan(ndcgAt(last, qrels, 10)); // not blind
    expect(ndcgAt(last, qrels, 10)).toBeCloseTo(1 / Math.log2(5), 8); // 3/log2(5) / 3
  });
});

describe("MRR", () => {
  it("is the reciprocal of the first relevant rank", () => {
    const qrels = q({ a: 0, b: 0, c: 2 });
    expect(reciprocalRank(["a", "b", "c"], qrels)).toBeCloseTo(1 / 3, 10);
    expect(reciprocalRank(["c", "a"], qrels)).toBe(1);
    expect(reciprocalRank(["a", "b"], qrels)).toBe(0);
  });
});

describe("judged@k — the trust gauge", () => {
  it("reports how much of the top k was actually looked at", () => {
    const qrels = q({ a: 1, b: 0 }); // b judged non-relevant is still JUDGED
    expect(judgedAt(["a", "b", "unseen", "unseen2"], qrels, 4)).toBeCloseTo(0.5, 10);
  });
});

describe("RBO", () => {
  it("is 1.0 for identical rankings — the clean-refactor case", () => {
    expect(rbo(["a", "b", "c"], ["a", "b", "c"], 0.9)).toBeCloseTo(1, 10);
  });
  it("is 0 for disjoint rankings", () => {
    expect(rbo(["a", "b"], ["x", "y"], 0.9)).toBeCloseTo(0, 10);
  });
  // d=1: A={a} B={b}, overlap 0 -> 0.  d=2: A={a,b} B={b,a}, overlap 2 -> 2/2 = 1.
  // sum = 0*0.9^0 + 1*0.9^1 = 0.9 ; raw = (1-0.9)*0.9 = 0.09
  // normalised by 1 - 0.9^2 = 0.19  ->  0.09/0.19 = 0.473684...
  it("matches a hand-computed value for a top-two swap", () => {
    expect(rbo(["a", "b"], ["b", "a"], 0.9)).toBeCloseTo(0.4736842105, 9);
  });
  it("weights the top: a deep change moves it less than a shallow one", () => {
    const base = ["a", "b", "c", "d", "e"];
    const shallow = ["b", "a", "c", "d", "e"];
    const deep = ["a", "b", "c", "e", "d"];
    expect(rbo(base, deep, 0.9)).toBeGreaterThan(rbo(base, shallow, 0.9));
  });
});

describe("paired permutation test", () => {
  it("finds no significance in noise", () => {
    const a = [0.5, 0.6, 0.4, 0.55, 0.45, 0.5, 0.52, 0.48];
    const b = [0.51, 0.59, 0.41, 0.54, 0.46, 0.49, 0.53, 0.47];
    expect(pairedPermutationTest(a, b).p).toBeGreaterThan(0.05);
  });

  it("detects a consistent improvement across queries", () => {
    const a = Array.from({ length: 40 }, (_, i) => 0.4 + (i % 5) * 0.01);
    const b = a.map((x) => x + 0.08); // every query improves
    const { meanDelta, p } = pairedPermutationTest(a, b);
    expect(meanDelta).toBeCloseTo(0.08, 6);
    expect(p).toBeLessThan(0.05);
  });

  it("is deterministic — a gate that reports a new p each run is not a gate", () => {
    const a = [0.1, 0.4, 0.2, 0.7, 0.3];
    const b = [0.2, 0.5, 0.1, 0.8, 0.4];
    expect(pairedPermutationTest(a, b).p).toBe(pairedPermutationTest(a, b).p);
  });

  it("never reports p = 0, which no finite sample supports", () => {
    const a = Array.from({ length: 60 }, () => 0.1);
    const b = Array.from({ length: 60 }, () => 0.9);
    expect(pairedPermutationTest(a, b).p).toBeGreaterThan(0);
  });
});

describe("mean", () => {
  it("skips queries with no relevant documents rather than scoring them 0", () => {
    expect(mean([1, Number.NaN, 0])).toBeCloseTo(0.5, 10);
  });
});
