/**
 * Structural checks: SCHEMA (the body says what it is), TREE (the shape the
 * body claims is the shape it has) and META (the body's own stamps and its
 * generated fields). Nothing here re-derives a scoring rule — admissibility
 * comes from `decisionSpace`, the ceiling from `REGISTERED_CONSTANTS.maxDepth`,
 * and the generated fields from `assemble` — so the checker cannot drift from
 * the scorer or from the assembler.
 *
 * Every message states the OBSERVED value and the EXPECTED one, because a
 * refusal is read aloud and has to explain itself without the source to hand.
 */
import type { Check, CheckContext } from "../analyse.js";
import { REGISTERED_CONSTANTS as K } from "../constants.js";
import type { Finding, RequirementNodeT } from "../schema.js";
import { DECISIONS, parseReqs, walk } from "../schema.js";
import { decisionSpace, isFib, magnitude, zone } from "../scoring.js";

/** The one id the root is allowed to have; every other id extends it. */
const ROOT_ID = "REQ-ROOT";

/** `${path}: ${message}` — the shape `parseReqs` already produces. */
export function schemaIssueFindings(issues: string[]): Finding[] {
  return issues.map((issue) => {
    const at = issue.split(":")[0] ?? "(root)";
    return {
      id: "SCHEMA-001",
      severity: "error" as const,
      path: at,
      // The framing is chosen from the issue's own path. It used to be an
      // unconditional "does not satisfy schemaVersion 1.0", which announced an
      // off-band score as a version mismatch — the one thing it was not. Only a
      // genuine schemaVersion issue gets the version framing now; every other
      // issue is left to speak for itself, since zod's text already names the
      // field and what was expected there.
      message:
        at === "schemaVersion"
          ? `the body does not declare schemaVersion 1.0 — ${issue}`
          : `the body does not satisfy the requirements schema — ${issue}`,
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

/**
 * The whole expectation clause, not just the noun phrase: "expected one of leaf"
 * is not English, and every one of these sentences is read aloud from a stage.
 */
const expectation = (d: readonly string[]): string =>
  d.length === 0
    ? "expected none — no decision at all is admissible at those bands"
    : d.length === 1
      ? `expected "${d[0]}", the only admissible decision there`
      : `expected one of ${d.join(", ")}`;

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

const SCHEMA_006: Check = {
  id: "SCHEMA-006",
  severity: "error",
  run({ body }: CheckContext) {
    // The id pattern alone accepts "REQ-ROOT.1" at the root, and SCHEMA-002
    // exempts the root from the extends-its-parent rule, so without this check a
    // tree could be re-rooted one level down and every other id would still
    // validate against it. The root is the anchor of every path in every
    // finding; it is fixed.
    if (body.tree.id === ROOT_ID) return [];
    return [
      {
        id: "SCHEMA-006",
        severity: "error",
        path: `${body.tree.id}.id`,
        message: `the root node is "${body.tree.id}"; expected exactly "${ROOT_ID}" — every other node id extends the root's, so a re-rooted tree renumbers the whole artefact`,
      },
    ];
  },
};

const SCHEMA_007: Check = {
  id: "SCHEMA-007",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    // TREE-005 guards nodeKey; ids are a separate namespace and are what
    // traceability, clarifications and residuals all point at. Two nodes sharing
    // an id makes every one of those references ambiguous.
    const seen = new Map<string, string>();
    for (const { node } of walk(body.tree)) {
      const owner = seen.get(node.id);
      if (owner === undefined) {
        seen.set(node.id, node.nodeKey);
        continue;
      }
      out.push({
        id: "SCHEMA-007",
        severity: "error",
        path: `${node.id}.id`,
        message: `node id "${node.id}" is used twice — once by the node with nodeKey "${owner}" and again by the node with nodeKey "${node.nodeKey}"; expected every node id to be unique, since traceability and residuals reference nodes by id`,
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
          )}); ${expectation(admissible)}`,
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

/** `Date.parse` in one place, so every timestamp is judged by the same rule. */
const instant = (at: unknown): number | null => {
  if (typeof at !== "string") return null;
  const n = Date.parse(at);
  return Number.isNaN(n) ? null : n;
};

const ISO_EXAMPLE = "2026-07-30T00:00:00.000Z";

const META_001: Check = {
  id: "META-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const { createdAt, updatedAt } = body.metadata as {
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    if (updatedAt === undefined || updatedAt === null) {
      out.push({
        id: "META-001",
        severity: "error",
        path: "metadata.updatedAt",
        message: `metadata.updatedAt is absent; expected an ISO-8601 instant at or after metadata.createdAt ${JSON.stringify(
          createdAt ?? null,
        )} — it is the staleness pin every later phase compares against`,
      });
      return out;
    }
    const u = instant(updatedAt);
    if (u === null) {
      out.push({
        id: "META-001",
        severity: "error",
        path: "metadata.updatedAt",
        message: `metadata.updatedAt ${JSON.stringify(
          updatedAt,
        )} is not a parseable timestamp; expected an ISO-8601 instant such as ${ISO_EXAMPLE}`,
      });
      return out;
    }
    const c = instant(createdAt);
    // An unparseable createdAt is META-003's verdict, not this one's; there is
    // nothing to compare against here.
    if (c !== null && u < c)
      out.push({
        id: "META-001",
        severity: "error",
        path: "metadata.updatedAt",
        message: `metadata.updatedAt ${String(updatedAt)} is earlier than metadata.createdAt ${String(
          createdAt,
        )}; expected a stamp at or after ${String(createdAt)} — a body cannot have been updated before it existed`,
      });
    return out;
  },
};

const META_002: Check = {
  id: "META-002",
  severity: "error",
  run({ body, assembled }: CheckContext) {
    const out: Finding[] = [];
    const differ = (path: string, what: string, observed: unknown, expected: unknown) => {
      if (observed === expected) return;
      out.push({
        id: "META-002",
        severity: "error",
        path,
        message: `${what} is generated, never authored: found ${JSON.stringify(
          observed ?? null,
        )}, expected ${JSON.stringify(expected ?? null)} when recomputed from the body`,
      });
    };

    // `assembled` is this same body run back through the assembler, so the two
    // walks visit the same nodes in the same order by construction.
    const authored = [...walk(body.tree)];
    const generated = [...walk(assembled.tree)];
    for (let i = 0; i < Math.min(authored.length, generated.length); i += 1) {
      const a = authored[i]!;
      const g = generated[i]!.node;
      const { node, path } = a;
      differ(`${path}.score.magnitude`, "score.magnitude", node.score.magnitude, g.score.magnitude);
      differ(`${path}.isLeaf`, "isLeaf", node.isLeaf, g.isLeaf);
      node.grounding.forEach((grounding, gi) => {
        differ(
          `${path}.grounding.${gi}.hedged`,
          `grounding.${gi}.hedged`,
          grounding.hedged,
          g.grounding[gi]?.hedged,
        );
      });
      (node.acceptanceCriteria ?? []).forEach((ac, ai) => {
        differ(
          `${path}.acceptanceCriteria.${ai}.observable`,
          `${ac.id}.observable`,
          ac.observable,
          g.acceptanceCriteria?.[ai]?.observable,
        );
      });
    }

    for (const key of new Set([
      ...Object.keys(body.traceability),
      ...Object.keys(assembled.traceability),
    ]))
      differ(
        `traceability.${key}`,
        `the traceability entry for ${key}`,
        body.traceability[key],
        assembled.traceability[key],
      );

    // `coverage` is optional: an absent key is not a disagreement, there is
    // simply nothing authored there to disagree with the recompute.
    if (body.coverage !== undefined) {
      const want = assembled.coverage;
      for (const field of Object.keys(body.coverage) as (keyof typeof body.coverage)[])
        differ(`coverage.${field}`, `coverage.${field}`, body.coverage[field], want?.[field]);
    }
    return out;
  },
};

const META_003: Check = {
  id: "META-003",
  severity: "error",
  run({ body }: CheckContext) {
    // No other check owns timestamp FORMAT, and several checks compare stamps —
    // SCORE-005 above all, which used to skip its comparison whenever
    // `Date.parse` returned NaN. A reversed history stamped "much later" would
    // therefore pass the whole gate with no findings at all. Every stamp in the
    // body is parseable or the artefact is refused here.
    const stamps: { path: string; value: unknown }[] = [
      { path: "metadata.createdAt", value: body.metadata.createdAt },
      { path: "metadata.updatedAt", value: body.metadata.updatedAt },
    ];
    for (const { node, path } of walk(body.tree)) {
      stamps.push({ path: `${path}.score.at`, value: node.score.at });
      node.scoreHistory.forEach((p, i) =>
        stamps.push({ path: `${path}.scoreHistory.${i}.at`, value: p.at }),
      );
      node.grounding.forEach((g, i) =>
        stamps.push({ path: `${path}.grounding.${i}.retrievedAt`, value: g.retrievedAt }),
      );
    }
    body.clarifications.forEach((c, ci) => {
      if (c.answeredAt !== undefined)
        stamps.push({ path: `clarifications.${ci}.answeredAt`, value: c.answeredAt });
      c.grounding.forEach((g, i) =>
        stamps.push({
          path: `clarifications.${ci}.grounding.${i}.retrievedAt`,
          value: g.retrievedAt,
        }),
      );
    });
    body.residuals.forEach((r, i) =>
      stamps.push({ path: `residuals.${i}.acceptedAt`, value: r.acceptedAt }),
    );
    (body.signoff?.approvers ?? []).forEach((a, i) =>
      stamps.push({ path: `signoff.approvers.${i}.at`, value: a.at }),
    );

    return stamps
      .filter((s) => instant(s.value) === null)
      .map((s) => ({
        id: "META-003",
        severity: "error" as const,
        path: s.path,
        message: `${s.path} is ${JSON.stringify(
          s.value ?? null,
        )}, which Date.parse cannot read; expected an ISO-8601 instant such as ${ISO_EXAMPLE} — checks that order the history are only as trustworthy as the stamps they compare`,
      }));
  },
};

export const STRUCTURAL_CHECKS: Check[] = [
  SCHEMA_001,
  SCHEMA_002,
  SCHEMA_003,
  SCHEMA_004,
  SCHEMA_005,
  SCHEMA_006,
  SCHEMA_007,
  TREE_001,
  TREE_002,
  TREE_003,
  TREE_004,
  TREE_005,
  TREE_006,
  META_001,
  META_002,
  META_003,
];
