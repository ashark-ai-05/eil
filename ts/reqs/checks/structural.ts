/**
 * Structural checks: SCHEMA (the body says what it is) and TREE (the shape the
 * body claims is the shape it has). Nothing here re-derives a scoring rule —
 * admissibility comes from `decisionSpace`, the ceiling from
 * `REGISTERED_CONSTANTS.maxDepth` — so the checker cannot drift from the scorer.
 *
 * Every message states the OBSERVED value and the EXPECTED one, because a
 * refusal is read aloud and has to explain itself without the source to hand.
 */
import type { Check, CheckContext } from "../analyse.js";
import { REGISTERED_CONSTANTS as K } from "../constants.js";
import type { Finding, RequirementNodeT } from "../schema.js";
import { DECISIONS, parseReqs, walk } from "../schema.js";
import { decisionSpace, isFib, magnitude, zone } from "../scoring.js";

/** `${path}: ${message}` — the shape `parseReqs` already produces. */
export function schemaIssueFindings(issues: string[]): Finding[] {
  return issues.map((issue) => {
    const at = issue.split(":")[0] ?? "(root)";
    return {
      id: "SCHEMA-001",
      severity: "error" as const,
      path: at,
      message: `the body does not satisfy schemaVersion 1.0 — ${issue}`,
    };
  });
}

/** Structural parent, by object identity. `walk` yields the live nodes. */
function parentIndex(root: RequirementNodeT): Map<RequirementNodeT, RequirementNodeT> {
  const parents = new Map<RequirementNodeT, RequirementNodeT>();
  for (const { node } of walk(root)) for (const c of node.children ?? []) parents.set(c, node);
  return parents;
}

/** How a structural key is present, for messages that distinguish `[]` from absent. */
function presence(node: RequirementNodeT, key: "children" | "acceptanceCriteria"): string {
  if (!(key in node)) return "absent";
  const v = node[key];
  if (v === undefined) return "present holding undefined";
  return `present with ${v.length} ${v.length === 1 ? "entry" : "entries"}`;
}

const fmtDecisions = (d: readonly string[]) => (d.length === 0 ? "(none)" : d.join(", "));

const SCHEMA_001: Check = {
  id: "SCHEMA-001",
  severity: "error",
  run({ body }: CheckContext) {
    // `analyse` short-circuits on a parse failure, so this only ever fires when a
    // caller runs the checks directly over an unvalidated body. Defence in depth:
    // the check owns the verdict wherever the body came from.
    const parsed = parseReqs(body);
    return parsed.ok ? [] : schemaIssueFindings(parsed.issues);
  },
};

const SCHEMA_002: Check = {
  id: "SCHEMA-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const parents = parentIndex(body.tree);
    for (const { node, path } of walk(body.tree)) {
      if (!parents.has(node)) continue; // the root extends nothing
      // Checked against the DECLARED parentId; SCHEMA-003 owns whether that
      // declaration is absent or names the wrong node.
      const declared = node.parentId;
      if (declared === undefined) continue;
      const prefix = `${declared}.`;
      const suffix = node.id.startsWith(prefix) ? node.id.slice(prefix.length) : null;
      if (suffix === null || !/^[1-9]\d*$/.test(suffix))
        out.push({
          id: "SCHEMA-002",
          severity: "error",
          path: `${path}.id`,
          message: `node id "${node.id}" does not extend its parent's — expected "${declared}.<n>" for a positive integer n, found ${
            suffix === null ? `no "${declared}." prefix` : `the segment "${suffix}"`
          }`,
        });
    }
    return out;
  },
};

const SCHEMA_003: Check = {
  id: "SCHEMA-003",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const parents = parentIndex(body.tree);
    for (const { node, path } of walk(body.tree)) {
      const actual = parents.get(node);
      const declared = node.parentId;
      if (actual === undefined) {
        if (declared !== undefined)
          out.push({
            id: "SCHEMA-003",
            severity: "error",
            path: `${path}.parentId`,
            message: `the root carries parentId "${declared}"; expected the key to be absent (structural fields are absent, never empty)`,
          });
        continue;
      }
      if (declared === undefined)
        out.push({
          id: "SCHEMA-003",
          severity: "error",
          path: `${path}.parentId`,
          message: `non-root node "${node.id}" omits parentId; expected "${actual.id}", found none`,
        });
      else if (declared !== actual.id)
        out.push({
          id: "SCHEMA-003",
          severity: "error",
          path: `${path}.parentId`,
          message: `parentId "${declared}" is not this node's actual parent; expected "${actual.id}"`,
        });
    }
    return out;
  },
};

const SCHEMA_004: Check = {
  id: "SCHEMA-004",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      // Key PRESENCE, not emptiness: the assembler emits no key at all for the
      // side of the split a node is not on, so `children: []` on a leaf is
      // itself the tamper signal.
      if (node.decision === "leaf" && "children" in node)
        out.push({
          id: "SCHEMA-004",
          severity: "error",
          path: `${path}.children`,
          message: `a leaf must carry no "children" key at all; found it ${presence(node, "children")} (expected absent)`,
        });
      if (node.decision !== "leaf" && "acceptanceCriteria" in node)
        out.push({
          id: "SCHEMA-004",
          severity: "error",
          path: `${path}.acceptanceCriteria`,
          message: `a "${node.decision}" branch must carry no "acceptanceCriteria" key at all; found it ${presence(
            node,
            "acceptanceCriteria",
          )} (expected absent — acceptance criteria belong on leaves)`,
        });
    }
    return out;
  },
};

const SCHEMA_005: Check = {
  id: "SCHEMA-005",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const known = DECISIONS as readonly string[];
    const bad = (where: string, value: unknown) => ({
      id: "SCHEMA-005",
      severity: "error" as const,
      path: where,
      message: `decision ${JSON.stringify(value)} is not a recognised decision; expected one of ${known.join(", ")}`,
    });
    for (const { node, path } of walk(body.tree)) {
      if (!known.includes(node.decision)) out.push(bad(`${path}.decision`, node.decision));
      // score is the current pass; history is every earlier one.
      if (!known.includes(node.score.decision))
        out.push(bad(`${path}.score.decision`, node.score.decision));
      node.scoreHistory.forEach((p, i) => {
        if (!known.includes(p.decision))
          out.push(bad(`${path}.scoreHistory.${i}.decision`, p.decision));
      });
    }
    return out;
  },
};

const TREE_001: Check = {
  id: "TREE-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      const { unknowns: u, complexity: c } = node.score;
      if (!isFib(u) || !isFib(c)) continue; // SCORE-002 owns the bands
      const admissible = decisionSpace(u, c);
      if (!(admissible as readonly string[]).includes(node.decision))
        out.push({
          id: "TREE-001",
          severity: "error",
          path: `${path}.decision`,
          message: `decision "${node.decision}" is inadmissible at U=${u} C=${c} (M=${magnitude(u, c)}, zone ${zone(
            magnitude(u, c),
          )}); expected one of ${fmtDecisions(admissible)}`,
        });
    }
    return out;
  },
};

const TREE_002: Check = {
  id: "TREE-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      if (node.decision !== "decompose") continue;
      const n = (node.children ?? []).length;
      if (n < 2)
        out.push({
          id: "TREE-002",
          severity: "error",
          path: `${path}.children`,
          message: `a decompose has ${n} ${n === 1 ? "child" : "children"}; expected at least 2 (a single child is a rename, not a decomposition)`,
        });
    }
    return out;
  },
};

const TREE_003: Check = {
  id: "TREE-003",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, depth, path } of walk(body.tree)) {
      if (depth > K.maxDepth)
        out.push({
          id: "TREE-003",
          severity: "error",
          path,
          message: `node "${node.id}" sits at depth ${depth}; expected at most maxDepth ${K.maxDepth}`,
        });
    }
    return out;
  },
};

const TREE_004: Check = {
  id: "TREE-004",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, depth, path } of walk(body.tree)) {
      if (depth !== K.maxDepth || node.decision === "leaf") continue;
      const clarifying = body.clarifications.filter((c) => c.nodeId === node.id).length;
      if (clarifying > 0 || node.residualRef !== undefined) continue;
      out.push({
        id: "TREE-004",
        severity: "error",
        path,
        message: `node "${node.id}" is a "${node.decision}" at maxDepth ${K.maxDepth} with neither a clarification nor a residual; observed ${clarifying} clarifications referencing it and residualRef ${
          node.residualRef ?? "none"
        }, expected at least one of the two`,
      });
    }
    return out;
  },
};

const TREE_005: Check = {
  id: "TREE-005",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const seen = new Map<string, string>();
    for (const { node, path } of walk(body.tree)) {
      const owner = seen.get(node.nodeKey);
      if (owner === undefined) {
        seen.set(node.nodeKey, node.id);
        continue;
      }
      out.push({
        id: "TREE-005",
        severity: "error",
        path: `${path}.nodeKey`,
        message: `nodeKey "${node.nodeKey}" on node "${node.id}" is already used by node "${owner}"; expected every nodeKey to be unique`,
      });
    }
    return out;
  },
};

const TREE_006: Check = {
  id: "TREE-006",
  // WARNING, never an error: uniform depth is a forensic signal that a tree was
  // drawn up front rather than genuinely discovered. It is evidence, not a
  // defect, and it must never block emission.
  severity: "warning",
  run({ body }: CheckContext) {
    const depths: number[] = [];
    for (const { node, depth } of walk(body.tree)) if (node.decision === "leaf") depths.push(depth);
    if (depths.length < 2) return [];
    const distinct = [...new Set(depths)];
    if (distinct.length !== 1) return [];
    return [
      {
        id: "TREE-006",
        severity: "warning",
        path: body.tree.id,
        message: `all ${depths.length} leaves sit at depth ${distinct[0]}; expected more than one distinct leaf depth — uniform depth is the signature of a pre-drawn tree rather than genuine discovery`,
      },
    ];
  },
};

export const STRUCTURAL_CHECKS: Check[] = [
  SCHEMA_001,
  SCHEMA_002,
  SCHEMA_003,
  SCHEMA_004,
  SCHEMA_005,
  TREE_001,
  TREE_002,
  TREE_003,
  TREE_004,
  TREE_005,
  TREE_006,
];
