/**
 * The single register every derived value is computed from. The human-readable
 * rubric and the analyser both read these, so documentation and code cannot
 * diverge and scorer and checker cannot disagree.
 *
 * Two kinds of coupling are recorded here, and both are recorded in comments
 * beside the constants themselves rather than left for a reader to rediscover:
 *
 *   - between constants in this register — `clarifyUnknownsFloor` only means
 *     anything at or above `thresholdDecompose`, because `decisionSpace` admits
 *     clarify in no other zone;
 *   - between this register and the retrieval arithmetic — the two grounding
 *     floors are on the RRF score scale, so they are DERIVED from `RRF_K` and
 *     not chosen as decimals. A retune of `RRF_K` moves them with it.
 *
 * The module stays pure: `RRF_K` is a number, the arithmetic is closed-form, and
 * nothing here reads a clock, a file or a random source.
 */
import { RRF_K } from "../core/fusion.js";

/** Estimation-poker bands: uncertainty grows super-linearly and false precision
 *  between bands is forbidden. Under magnitude = max, M is always itself a band,
 *  which is what lets the zone predicate collapse to a small decision table. */
export const FIB = [1, 2, 3, 5, 8, 13, 21] as const;

/**
 * One retrieval arm's contribution when it ranks a document FIRST: `w / (k + 0 + 1)`
 * with `w <= 1.0`, so `1 / (RRF_K + 1)` ≈ 0.0164. Every grounding floor below is
 * a multiple of this, which is the only scale a fused `top_score` lives on.
 */
const ONE_ARM_AT_RANK_1 = 1 / (RRF_K + 1);

export const REGISTERED_CONSTANTS = {
  /** M at or below this is atomic — finalise as a leaf. */
  thresholdAtomic: 2,
  /** M at or above this must break down. */
  thresholdDecompose: 5,
  /** Unknowns at or above this make `clarify` admissible. `recommendAction`
   *  gates its clarify drive rule through `decisionSpace`, which only admits
   *  clarify in the must_break_down zone — so if this floor is ever retuned
   *  below `thresholdDecompose`, clarify stays inadmissible below that zone
   *  regardless; retune `thresholdDecompose` too if that is not the intent. */
  clarifyUnknownsFloor: 5,
  /** Recursion ceiling; a branch at this depth must carry a clarification or residual. */
  maxDepth: 6,
  /** Retrieval arithmetic: below this top score there is nothing worth reading.
   *
   *  DERIVED, never a chosen decimal — `top_score` is a weighted RRF score, not a
   *  normalised relevance score, and the two are three-quarters of an order of
   *  magnitude apart. One arm ranking a document first contributes
   *  `1 / (RRF_K + 1)` ≈ 0.0164; five arms all agreeing at rank 0 give ≈0.082,
   *  and `ranking.modifier` scales that by at most TIER_PRIOR.curated 1.15 — a
   *  theoretical ceiling near 0.094, and nearer 0.057 on a prose route where
   *  fewer arms fire. Measured on the real demo catalog the best question scored
   *  0.032. A floor of 0.12 therefore sat ABOVE the achievable maximum and
   *  escalated every unknown on every corpus; `ts/tests/reqs-scoring.test.ts`
   *  now asserts this floor is strictly below that ceiling so the same class of
   *  scale error cannot come back silently.
   *
   *  The threshold means: at least roughly one and a half arms agree this is the
   *  top hit. Retuning RRF_K moves it, because the scale moved. */
  groundingTopScoreFloor: 1.5 * ONE_ARM_AT_RANK_1,
  /** Below this gap between rank 1 and rank 5 the sources disagree — escalate.
   *
   *  Same scale, same derivation: the top result must stand clear of the fifth by
   *  a meaningful fraction — 0.6 — of one arm's first-rank contribution, ≈0.0098.
   *  A gap is a DIFFERENCE of two fused scores, so it is bounded by the same
   *  ceiling as the scores themselves and cannot be judged on a 0-1 scale either. */
  groundingScoreGapFloor: 0.6 * ONE_ARM_AT_RANK_1,
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
