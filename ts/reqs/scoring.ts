/**
 * Every derived value, admissibility rule and recommendation. Pure and
 * side-effect free: the model emits only bounded judgments (two bands plus a
 * rationale) and everything downstream is computed here. The analyser imports
 * this same module rather than re-deriving the rules.
 */
import {
  DEFERRAL_MARKERS,
  FIB,
  HEDGE_LEXICON,
  REGISTERED_CONSTANTS as K,
  OBSERVABILITY_LEXICON,
} from "./constants.js";

export type Fib = (typeof FIB)[number];
export type Decision = "leaf" | "decompose" | "clarify";
export type Zone = "atomic" | "review" | "must_break_down";

export const isFib = (n: number): n is Fib => (FIB as readonly number[]).includes(n);

/** max, by default and in practice. Guarantees M is itself a band. */
export const magnitude = (u: Fib, c: Fib): Fib => Math.max(u, c) as Fib;

export const zone = (m: Fib): Zone =>
  m <= K.thresholdAtomic ? "atomic" : m < K.thresholdDecompose ? "review" : "must_break_down";

/** Enumerates what is admissible without choosing. */
export function decisionSpace(u: Fib, c: Fib): Decision[] {
  const z = zone(magnitude(u, c));
  const out: Decision[] = [];
  if (z === "atomic" || z === "review") out.push("leaf");
  if (z !== "atomic") out.push("decompose");
  if (z === "must_break_down" && u >= K.clarifyUnknownsFloor) out.push("clarify");
  return out;
}

/**
 * Adds the clarify drive rule: when a structural pass leaves the unknowns at or
 * above where they started and at or above the floor, decomposing again is
 * blind — the unknown is inherent and a human has to be asked. The drive rule
 * only ever selects "clarify", so it is gated through `decisionSpace` rather
 * than re-deriving admissibility here — the two functions cannot disagree
 * about what is legal, under any retuning of the thresholds.
 */
export function recommendAction(u: Fib, c: Fib, priorU?: Fib): Decision {
  const admissible = decisionSpace(u, c);
  if (
    priorU !== undefined &&
    u >= priorU &&
    u >= K.clarifyUnknownsFloor &&
    admissible.includes("clarify")
  ) {
    return "clarify";
  }
  const z = zone(magnitude(u, c));
  return z === "must_break_down" ? "decompose" : "leaf";
}

/**
 * Task 1's corpus is hard-wrapped prose, so a hedge phrase like "check with the
 * psr-limits team" can legitimately contain a newline mid-phrase. The haystack
 * is normalised — runs of whitespace collapsed to a single space — before
 * matching; the needles are authored single-spaced and left untouched.
 */
const containsAny = (text: string, needles: readonly string[]): boolean => {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  return needles.some((n) => t.includes(n));
};

export const hasHedge = (text: string): boolean => containsAny(text, HEDGE_LEXICON);
export const hasDeferral = (text: string): boolean => containsAny(text, DEFERRAL_MARKERS);
export const isObservable = (text: string): boolean =>
  /\d/.test(text) || containsAny(text, OBSERVABILITY_LEXICON);
