/**
 * SCORE and UNCERT. Both families reason over the score history, which is why
 * they live together: the history is the audit trail of how a node was reached,
 * and the checks here refuse a trail that does not add up.
 *
 * Nothing is re-derived. `magnitude` and `zone` come from `scoring.js` and the
 * clarify floor from `REGISTERED_CONSTANTS`, so a retuned threshold moves the
 * scorer and the checker together or not at all.
 */
import type { Check, CheckContext } from "../analyse.js";
import { FIB, REGISTERED_CONSTANTS as K } from "../constants.js";
import type { Finding, RequirementNodeT } from "../schema.js";
import { walk } from "../schema.js";
import { isFib, magnitude, zone } from "../scoring.js";

type Pass = RequirementNodeT["score"];

const fmtPass = (p: Pass) =>
  `U=${p.unknowns} C=${p.complexity} M=${p.magnitude} decision=${p.decision} at=${p.at}${
    p.note === undefined ? "" : ` note=${JSON.stringify(p.note)}`
  }`;

/** Order-independent value identity over the whole pass, `note` included. */
const canon = (p: Pass) =>
  JSON.stringify([p.unknowns, p.complexity, p.magnitude, p.decision, p.at, p.note ?? null]);

/** `at` is a free string in the schema; unparseable stamps are not this check's. */
const instant = (at: string): number | null => {
  const n = Date.parse(at);
  return Number.isNaN(n) ? null : n;
};

const SCORE_001: Check = {
  id: "SCORE-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      const want = magnitude(node.score.unknowns, node.score.complexity);
      if (node.score.magnitude !== want)
        out.push({
          id: "SCORE-001",
          severity: "error",
          path: `${path}.score.magnitude`,
          message: `stored magnitude ${node.score.magnitude}, recomputed ${want} from U=${node.score.unknowns} C=${node.score.complexity}`,
        });
      node.scoreHistory.forEach((p, i) => {
        const w = magnitude(p.unknowns, p.complexity);
        if (p.magnitude !== w)
          out.push({
            id: "SCORE-001",
            severity: "error",
            path: `${path}.scoreHistory.${i}.magnitude`,
            message: `stored magnitude ${p.magnitude}, recomputed ${w} from U=${p.unknowns} C=${p.complexity}`,
          });
      });
    }
    return out;
  },
};

const SCORE_002: Check = {
  id: "SCORE-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const bands = FIB.join(", ");
    const check = (where: string, field: "unknowns" | "complexity", value: number) => {
      if (isFib(value)) return;
      out.push({
        id: "SCORE-002",
        severity: "error",
        path: `${where}.${field}`,
        message: `${field} ${JSON.stringify(value)} is not a Fibonacci band; expected one of ${bands}`,
      });
    };
    for (const { node, path } of walk(body.tree)) {
      check(`${path}.score`, "unknowns", node.score.unknowns);
      check(`${path}.score`, "complexity", node.score.complexity);
      node.scoreHistory.forEach((p, i) => {
        check(`${path}.scoreHistory.${i}`, "unknowns", p.unknowns);
        check(`${path}.scoreHistory.${i}`, "complexity", p.complexity);
      });
    }
    return out;
  },
};

const SCORE_003: Check = {
  id: "SCORE-003",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      const last = node.scoreHistory[node.scoreHistory.length - 1];
      if (last === undefined) {
        out.push({
          id: "SCORE-003",
          severity: "error",
          path: `${path}.scoreHistory`,
          message: `scoreHistory is empty; expected at least one pass, the last of which is the current score (${fmtPass(
            node.score,
          )})`,
        });
        continue;
      }
      if (canon(node.score) !== canon(last))
        out.push({
          id: "SCORE-003",
          severity: "error",
          path: `${path}.score`,
          message: `observed score {${fmtPass(node.score)}}, expected the last scoreHistory entry (scoreHistory.${
            node.scoreHistory.length - 1
          }) {${fmtPass(last)}} — the current score must be exactly the final pass`,
        });
    }
    return out;
  },
};

const SCORE_005: Check = {
  id: "SCORE-005",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      for (let i = 1; i < node.scoreHistory.length; i += 1) {
        const prev = node.scoreHistory[i - 1]!;
        const cur = node.scoreHistory[i]!;
        const a = instant(prev.at);
        const b = instant(cur.at);
        if (a === null || b === null || b >= a) continue;
        out.push({
          id: "SCORE-005",
          severity: "error",
          path: `${path}.scoreHistory.${i}.at`,
          message: `pass ${i} is stamped ${cur.at}, earlier than pass ${i - 1} at ${prev.at}; expected a stamp at or after ${prev.at} (history must be non-decreasing in time)`,
        });
      }
    }
    return out;
  },
};

const SCORE_006: Check = {
  id: "SCORE-006",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      if (node.decision !== "leaf") continue;
      let lastClarify = -1;
      node.scoreHistory.forEach((p, i) => {
        if (p.decision === "clarify") lastClarify = i;
      });
      if (lastClarify === -1) continue;
      const asked = node.scoreHistory[lastClarify]!;
      if (node.score.unknowns < asked.unknowns) continue;
      out.push({
        id: "SCORE-006",
        severity: "error",
        path: `${path}.score.unknowns`,
        message: `finalised as a leaf with unknowns ${node.score.unknowns}, but the last clarify pass (scoreHistory.${lastClarify}) recorded unknowns ${asked.unknowns}; expected unknowns strictly below ${asked.unknowns} — a clarification that does not reduce uncertainty did not clarify anything`,
      });
    }
    return out;
  },
};

const UNCERT_001: Check = {
  id: "UNCERT-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const residualIds = new Set(body.residuals.map((r) => r.id));
    for (const { node, path } of walk(body.tree)) {
      const m = magnitude(node.score.unknowns, node.score.complexity);
      if (zone(m) !== "review" || node.decision !== "leaf") continue;
      if (!node.residualRef || !residualIds.has(node.residualRef))
        out.push({
          id: "UNCERT-001",
          severity: "error",
          path: `${path}.residualRef`,
          // The whole sentence branches, not just the noun phrase: with no
          // residuals recorded the old wording read "expected one of (no
          // residuals are recorded)", which is not a sentence anyone can say
          // out loud.
          message:
            residualIds.size === 0
              ? `a review-zone leaf (M=${m}) must reference an accepted residual; found ${
                  node.residualRef ?? "none"
                } and the body records no residuals at all, so expected one to be accepted by a named human and referenced here`
              : `a review-zone leaf (M=${m}) must reference an accepted residual; found ${
                  node.residualRef ?? "none"
                }, expected one of ${[...residualIds].join(", ")}`,
        });
    }
    return out;
  },
};

const UNCERT_002: Check = {
  id: "UNCERT-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    body.residuals.forEach((r, i) => {
      const by = r.acceptedBy as { kind?: unknown; name?: unknown } | undefined;
      const name = typeof by?.name === "string" ? by.name : "";
      const kind = by?.kind;
      if (kind !== "human")
        out.push({
          id: "UNCERT-002",
          severity: "error",
          path: `residuals.${i}.acceptedBy.kind`,
          message: `residual ${r.id} is accepted by kind ${JSON.stringify(
            kind ?? null,
          )}; expected "human" — a residual is only ever carried on a named human's authority`,
        });
      if (name.trim() === "")
        out.push({
          id: "UNCERT-002",
          severity: "error",
          path: `residuals.${i}.acceptedBy.name`,
          message: `residual ${r.id} records acceptedBy.name ${JSON.stringify(
            name,
          )}; expected a non-empty human name`,
        });
    });
    return out;
  },
};

const UNCERT_005: Check = {
  id: "UNCERT-005",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      for (let i = 1; i < node.scoreHistory.length; i += 1) {
        const prev = node.scoreHistory[i - 1]!;
        const cur = node.scoreHistory[i]!;
        // Mirrors the clarify drive rule in `recommendAction`: the CURRENT pass's
        // unknowns are the ones compared against the floor, so the two agree.
        if (cur.decision !== "decompose") continue;
        if (cur.unknowns < prev.unknowns) continue;
        if (cur.unknowns < K.clarifyUnknownsFloor) continue;
        out.push({
          id: "UNCERT-005",
          severity: "error",
          path: `${path}.scoreHistory.${i}.decision`,
          message: `pass ${i} decomposes with unknowns ${cur.unknowns}, not below pass ${i - 1}'s ${prev.unknowns} and at or above the clarify floor ${K.clarifyUnknownsFloor}; expected decision "clarify" — decomposing again without reducing an inherent unknown is blind`,
        });
      }
    }
    return out;
  },
};

export const SCORING_CHECKS: Check[] = [
  SCORE_001,
  SCORE_002,
  SCORE_003,
  SCORE_005,
  SCORE_006,
  UNCERT_001,
  UNCERT_002,
  UNCERT_005,
];
