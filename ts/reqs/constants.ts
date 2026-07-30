/**
 * The single register every derived value is computed from. The human-readable
 * rubric and the analyser both read these, so documentation and code cannot
 * diverge and scorer and checker cannot disagree.
 */

/** Estimation-poker bands: uncertainty grows super-linearly and false precision
 *  between bands is forbidden. Under magnitude = max, M is always itself a band,
 *  which is what lets the zone predicate collapse to a small decision table. */
export const FIB = [1, 2, 3, 5, 8, 13, 21] as const;

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
  /** Retrieval arithmetic: below this top score there is nothing worth reading. */
  groundingTopScoreFloor: 0.12,
  /** Below this gap between rank 1 and rank 5 the sources disagree — escalate. */
  groundingScoreGapFloor: 0.03,
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
