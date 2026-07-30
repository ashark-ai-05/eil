import { describe, expect, it } from "vitest";
import { RRF_K } from "../core/fusion.js";
import { TIER_PRIOR } from "../core/ranking.js";
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
  it("never recommends an action that decisionSpace forbids, for any threshold-plausible inputs", () => {
    const priorUCandidates = [undefined, ...FIB];
    for (const u of FIB) {
      for (const c of FIB) {
        const admissible = decisionSpace(u, c);
        for (const priorU of priorUCandidates) {
          const action = recommendAction(u, c, priorU);
          expect(admissible).toContain(action);
        }
      }
    }
  });
});

/**
 * The guard that makes a units error impossible to reintroduce quietly.
 *
 * `top_score` and `score_gap` are WEIGHTED RRF scores, not normalised relevance
 * scores, and nothing about the name says so. A floor picked as if the scale ran
 * 0-1 sits ABOVE everything the scale can produce, and the failure is silent by
 * construction: `tryKnowledgeBase` escalates before it spends a single get_doc,
 * so every unknown lands on a human, the grounding table comes out empty, and no
 * test, no log line and no exit code says why. That is exactly what a floor of
 * 0.12 did here against an achievable maximum of ~0.094.
 *
 * So the ceiling is RECOMPUTED from the fusion constant and the ranking modifier
 * on every run, and the floors are asserted strictly below it. If RRF_K, the
 * arm set or TIER_PRIOR is retuned and a floor is left behind, this fails first.
 */
describe("the grounding floors are reachable on the scale they are measured on", () => {
  /** `rrf` gives an arm ranking a document first `w / (k + 0 + 1)`, with `w <= 1`. */
  const ONE_ARM_AT_RANK_1 = 1 / (RRF_K + 1);

  /** fts_prose, fts_prose_loose, fts_code, fts_code_loose, vec — `armWeights` in
   *  ts/search.ts names exactly these, and an arm absent from a result set
   *  contributes nothing at all. */
  const MAX_ARMS = 5;

  /** A prose question (the only kind the cascade asks) fires the two prose arms
   *  and the vector arm at full weight; the code arms usually do not fire at all. */
  const PROSE_ROUTE_ARMS = 3;

  /** `modifier` is prior x recency, recency <= 1, so the ceiling is the best prior. */
  const MAX_MODIFIER = Math.max(...Object.values(TIER_PRIOR));

  /** Every arm agreeing at rank 0 on the best-tier, freshest document there is. */
  const maxTopScore = MAX_ARMS * ONE_ARM_AT_RANK_1 * MAX_MODIFIER;
  const maxProseTopScore = PROSE_ROUTE_ARMS * ONE_ARM_AT_RANK_1 * MAX_MODIFIER;
  /** `score_gap` is top1 - top5, and top5 >= 0, so the gap shares that ceiling. */
  const maxScoreGap = maxTopScore;

  it("the arithmetic still says what the constants say it says", () => {
    expect(maxTopScore).toBeCloseTo(0.094, 3);
    expect(maxProseTopScore).toBeCloseTo(0.057, 3);
  });

  it("groundingTopScoreFloor is strictly below the achievable maximum", () => {
    // A floor at or above the achievable maximum does not tighten the cascade —
    // it disables it. Every unknown escalates to a human on every corpus with
    // every model, the artefact's grounding table is empty, and the run still
    // exits 0. The floor must be a threshold, not a ceiling.
    expect(K.groundingTopScoreFloor).toBeGreaterThan(0);
    expect(K.groundingTopScoreFloor).toBeLessThan(maxTopScore);
    // And below the ceiling a PROSE question can actually reach, which is the
    // only route the resolution cascade ever takes.
    expect(K.groundingTopScoreFloor).toBeLessThan(maxProseTopScore);
  });

  it("groundingScoreGapFloor is strictly below the achievable gap", () => {
    // Same failure, same silence: a gap floor above the largest gap the scale can
    // produce refuses every result set as "the sources disagree".
    expect(K.groundingScoreGapFloor).toBeGreaterThan(0);
    expect(K.groundingScoreGapFloor).toBeLessThan(maxScoreGap);
    expect(K.groundingScoreGapFloor).toBeLessThan(maxProseTopScore);
  });

  it("both floors are derived from RRF_K rather than written as decimals", () => {
    // Stated as the multiple, so a hand-picked decimal pasted back in fails here
    // even if it happens to sit under today's ceiling.
    expect(K.groundingTopScoreFloor / ONE_ARM_AT_RANK_1).toBeCloseTo(1.5, 10);
    expect(K.groundingScoreGapFloor / ONE_ARM_AT_RANK_1).toBeCloseTo(0.6, 10);
  });
});

describe("lexicons", () => {
  it("detects hedged prose so the artefact cannot launder a source's uncertainty", () => {
    expect(hasHedge("There's a staleness cutoff, I think 5s")).toBe(true);
    expect(hasHedge("Haven't measured recently")).toBe(true);
    expect(hasHedge("The cutoff is 5s, asserted in the runbook")).toBe(false);
  });
  it("detects a hedge phrase with the newline inside the phrase itself", () => {
    expect(hasHedge("Check\nwith the psr-limits team")).toBe(true);
  });
  it("detects a different hedge phrase with the newline inside the phrase itself", () => {
    expect(hasHedge("Haven't\nmeasured recently")).toBe(true);
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
