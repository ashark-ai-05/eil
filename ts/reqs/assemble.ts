/**
 * Derived fields are generated, never authored. This module is their only
 * writer; the analyser calls it and compares, so a hand-edited generated field
 * is a gate error (META-002) rather than a silent lie.
 */
import type { ReqsBody, RequirementNodeT } from "./schema.js";
import { walk } from "./schema.js";
import { hasHedge, isObservable, magnitude } from "./scoring.js";

function assembleNode(node: RequirementNodeT): RequirementNodeT {
  // acceptanceCriteria/children are structural: assigned only when the source
  // node has them, never as an explicit `undefined`, so a leaf ends up with no
  // `children` key at all and a branch with no `acceptanceCriteria` key —
  // never a present key holding `undefined` or `[]`.
  const assembled: RequirementNodeT = {
    ...node,
    score: { ...node.score, magnitude: magnitude(node.score.unknowns, node.score.complexity) },
    scoreHistory: node.scoreHistory.map((p) => ({
      ...p,
      magnitude: magnitude(p.unknowns, p.complexity),
    })),
    isLeaf: node.decision === "leaf",
    grounding: node.grounding.map((g) => ({ ...g, hedged: hasHedge(g.quote) })),
  };
  if (node.acceptanceCriteria !== undefined) {
    assembled.acceptanceCriteria = node.acceptanceCriteria.map((ac) => ({
      ...ac,
      observable: ac.then.every((t) => isObservable(t)),
    }));
  }
  if (node.children !== undefined) {
    assembled.children = node.children.map(assembleNode);
  }
  return assembled;
}

export function assemble(body: ReqsBody): ReqsBody {
  const tree = assembleNode(body.tree);

  // The traceability index is INVERTED from the tree, never maintained by hand,
  // so a coverage index structurally cannot disagree with what it indexes.
  const traceability: Record<string, string> = {};
  let leaves = 0;
  let acs = 0;
  let unknownsTotal = 0;
  for (const { node } of walk(tree)) {
    unknownsTotal += 1;
    if (node.isLeaf) leaves += 1;
    for (const ac of node.acceptanceCriteria ?? []) {
      traceability[ac.id] = node.id;
      acs += 1;
    }
  }

  const grounded = body.clarifications.filter(
    (c) => c.answeredBy?.kind === "knowledge_base" && c.grounding.length > 0,
  ).length;
  const escalated = body.clarifications.filter(
    (c) => c.answeredBy?.kind === "human" || c.answeredBy === undefined,
  ).length;

  return {
    ...body,
    tree,
    traceability,
    coverage: { leaves, acs, unknownsTotal, grounded, escalated, carried: body.residuals.length },
    clarifications: body.clarifications.map((c) => ({
      ...c,
      grounding: c.grounding.map((g) => ({ ...g, hedged: hasHedge(g.quote) })),
    })),
  };
}

/** Ids are allocated monotonically above the highest ever used; retired ids are
 *  never reissued, so a traceability reference can never silently remap. */
export function nextAcId(body: ReqsBody): string {
  let max = 0;
  for (const { node } of walk(body.tree))
    for (const ac of node.acceptanceCriteria ?? [])
      max = Math.max(max, Number(ac.id.slice(3)) || 0);
  return `AC-${max + 1}`;
}
