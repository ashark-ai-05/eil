/**
 * Provenance and the gate: CLARIFY (a question was actually asked and actually
 * answered, and every citation is real), TRACE (the index and the tree agree)
 * and GATE (who may sign, and on what).
 *
 * CLARIFY-005 is the load-bearing one. It is the only check that leaves the
 * artefact: it re-fetches every cited document through the injected `resolveDoc`
 * and greps for the quote. That is what makes a fabricated citation mechanically
 * detectable rather than merely implausible.
 *
 * Every message states the OBSERVED value and the EXPECTED one, because a
 * refusal is read aloud and has to explain itself without the source to hand.
 */
import type { Check, CheckContext } from "../analyse.js";
import type { Finding, Grounding } from "../schema.js";
import { walk } from "../schema.js";
import { hasHedge } from "../scoring.js";

/** The roles a sign-off must cover before it is a sign-off at all. */
const REQUIRED_ROLES = ["PO", "TechLead", "QA"] as const;

/** The only admissible outcomes: this phase gates, it does not bless. */
const ADMISSIBLE_RESULTS = ["partial", "failed"] as const;

const empty = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";

/** A citation, wherever in the body it was made. */
interface Cited {
  path: string;
  docId: string;
  quote: string;
  /** the node whose claim this citation supports, for residual lookup */
  nodeId: string;
  g: Grounding;
}

/** Every citation in the body: on the tree, and on the clarifications. */
function citations(body: CheckContext["body"]): Cited[] {
  const out: Cited[] = [];
  for (const { node, path } of walk(body.tree))
    node.grounding.forEach((g, i) =>
      out.push({
        path: `${path}.grounding.${i}`,
        docId: g.docId,
        quote: g.quote,
        nodeId: node.id,
        g,
      }),
    );
  body.clarifications.forEach((c, ci) =>
    c.grounding.forEach((g, i) =>
      out.push({
        path: `clarifications.${ci}.grounding.${i}`,
        docId: g.docId,
        quote: g.quote,
        nodeId: c.nodeId,
        g,
      }),
    ),
  );
  return out;
}

const CLARIFY_001: Check = {
  id: "CLARIFY-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      const asked = node.scoreHistory.findIndex((p) => p.decision === "clarify");
      if (asked === -1) continue;
      const answering = body.clarifications.filter((c) => c.nodeId === node.id);
      if (answering.length > 0) continue;
      out.push({
        id: "CLARIFY-001",
        severity: "error",
        path: `${path}.scoreHistory.${asked}.decision`,
        message: `node "${node.id}" recorded a clarify pass at scoreHistory.${asked} but ${answering.length} clarifications name it; expected at least 1 clarification with nodeId "${node.id}" — a question the artefact does not record was never asked`,
      });
    }
    return out;
  },
};

const CLARIFY_002: Check = {
  id: "CLARIFY-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    body.clarifications.forEach((c, i) => {
      if (c.answer === undefined) {
        out.push({
          id: "CLARIFY-002",
          severity: "error",
          path: `clarifications.${i}.answer`,
          message: `${c.id} ("${c.question}") carries no answer at all; expected an answer naming either a chosenOptionId or a freetext — an unanswered question does not resolve anything`,
        });
        return;
      }
      const chosen = c.answer.chosenOptionId;
      const free = c.answer.freetext;
      if (!empty(chosen) || !empty(free)) return;
      out.push({
        id: "CLARIFY-002",
        severity: "error",
        path: `clarifications.${i}.answer`,
        message: `${c.id} carries an answer with chosenOptionId ${JSON.stringify(
          chosen ?? null,
        )} and freetext ${JSON.stringify(free ?? null)}; expected at least one of the two to be non-empty`,
      });
    });
    return out;
  },
};

const CLARIFY_003: Check = {
  id: "CLARIFY-003",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    body.clarifications.forEach((c, i) => {
      if (c.answeredBy?.kind !== "knowledge_base") return;
      if (c.grounding.length > 0) return;
      out.push({
        id: "CLARIFY-003",
        severity: "error",
        path: `clarifications.${i}.grounding`,
        message: `${c.id} is answered by the knowledge base ("${c.answeredBy.name}") with ${c.grounding.length} citations; expected at least 1 — an answer the corpus supposedly gave must name where in the corpus it came from`,
      });
    });
    return out;
  },
};

const CLARIFY_004: Check = {
  id: "CLARIFY-004",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    body.clarifications.forEach((c, ci) => {
      c.options.forEach((o, oi) => {
        if (!empty(o.implication)) return;
        out.push({
          id: "CLARIFY-004",
          severity: "error",
          path: `clarifications.${ci}.options.${oi}.implication`,
          message: `option ${o.id} of ${c.id} ("${o.text}") records implication ${JSON.stringify(
            o.implication ?? null,
          )}; expected a statement of what choosing it commits the delivery to — an option with no stated consequence is not a choice a human can make`,
        });
      });
    });
    return out;
  },
};

/** Runs of whitespace to a single space, and NOTHING else: a quote is verbatim. */
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

const CLARIFY_005: Check = {
  id: "CLARIFY-005",
  severity: "error",
  async run({ body, resolveDoc }: CheckContext) {
    // Skipped, never silently passed: `analyse` drops this check out of
    // `checksRun` when no resolver is injected, so the count itself records that
    // no citation was verified on this run.
    if (!resolveDoc) return [];
    const out: Finding[] = [];
    const cited = citations(body);

    // One fetch per DISTINCT document, not one per citation: a page cited eight
    // times is read once.
    const docs = new Map<string, string | null>();
    for (const c of cited) if (!docs.has(c.docId)) docs.set(c.docId, await resolveDoc(c.docId));

    for (const c of cited) {
      const text = docs.get(c.docId);
      // An unresolvable document is an ERROR, not a skip. A citation to a
      // document the caller cannot see must fail verification: "we could not
      // check it" is the state a fabricated citation is indistinguishable from.
      if (text === null || text === undefined) {
        out.push({
          id: "CLARIFY-005",
          severity: "error",
          path: `${c.path}.docId`,
          message: `cited document ${c.docId} could not be resolved, so the quote ${JSON.stringify(
            c.quote.slice(0, 80),
          )} cannot be verified; expected a document the corpus can return`,
        });
        continue;
      }
      if (normalise(text).includes(normalise(c.quote))) continue;
      out.push({
        id: "CLARIFY-005",
        severity: "error",
        path: `${c.path}.quote`,
        message: `quote is not present verbatim in ${c.docId}: found ${JSON.stringify(
          c.quote.slice(0, 80),
        )}, expected a run of text that occurs in that document character for character (whitespace aside)`,
      });
    }
    return out;
  },
};

const CLARIFY_006: Check = {
  id: "CLARIFY-006",
  // WARNING, never an error: the grounding stands. A hedged source is legitimate
  // evidence — it just may not be laundered into a fact, so it has to carry a
  // residual saying so.
  severity: "warning",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const carried = new Set(body.residuals.map((r) => r.nodeId));
    for (const c of citations(body)) {
      if (!hasHedge(c.quote)) continue;
      if (carried.has(c.nodeId)) continue;
      out.push({
        id: "CLARIFY-006",
        severity: "warning",
        path: `${c.path}.quote`,
        message: `the quote cited for node "${c.nodeId}" hedges (${JSON.stringify(
          c.quote.slice(0, 80),
        )}) and no residual names that node; expected a residual with nodeId "${c.nodeId}" — a source that says "I think" must not be cited as if it asserted`,
      });
    }
    return out;
  },
};

const TRACE_001: Check = {
  id: "TRACE-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node } of walk(body.tree))
      for (const ac of node.acceptanceCriteria ?? []) {
        const mapped = body.traceability[ac.id];
        if (mapped === node.id) continue;
        out.push({
          id: "TRACE-001",
          severity: "error",
          path: `traceability.${ac.id}`,
          message:
            mapped === undefined
              ? `${ac.id} is stated on node "${node.id}" but is absent from the traceability index; expected traceability.${ac.id} to be "${node.id}"`
              : `${ac.id} is stated on node "${node.id}" but the traceability index maps it to "${mapped}"; expected "${node.id}"`,
        });
      }
    return out;
  },
};

const TRACE_002: Check = {
  id: "TRACE-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const ids = new Set<string>();
    for (const { node } of walk(body.tree)) ids.add(node.id);
    for (const [acId, nodeId] of Object.entries(body.traceability)) {
      if (ids.has(nodeId)) continue;
      out.push({
        id: "TRACE-002",
        severity: "error",
        path: `traceability.${acId}`,
        message: `the traceability index maps ${acId} to node "${nodeId}", which is not in the tree; expected one of the ${ids.size} node ids the tree actually contains`,
      });
    }
    return out;
  },
};

/**
 * Reserved: refinement of an already-baselined requirement — the case where a
 * node changes after a baseline has been cut and every downstream artefact has
 * to be renumbered against it. There is no baseline in phase 1, so there is
 * nothing to be inconsistent with and NOTHING for this check to compare. It is
 * registered so the id is reserved and cannot be reused for something else, and
 * it returns no findings by design. This is a scoping decision, not a stub
 * anyone forgot to finish.
 */
const TRACE_007: Check = {
  id: "TRACE-007",
  severity: "error",
  run() {
    return [];
  },
};

const GATE_001: Check = {
  id: "GATE-001",
  severity: "error",
  run({ body }: CheckContext) {
    const s = body.signoff;
    if (s === undefined) return [];
    if ((ADMISSIBLE_RESULTS as readonly string[]).includes(s.result)) return [];
    return [
      {
        id: "GATE-001",
        severity: "error",
        path: "signoff.result",
        message: `the sign-off records result ${JSON.stringify(
          s.result,
        )}; expected one of ${ADMISSIBLE_RESULTS.join(", ")} — this phase gates a requirement set, it never certifies one as passed`,
      },
    ];
  },
};

const GATE_002: Check = {
  id: "GATE-002",
  severity: "error",
  run({ body }: CheckContext) {
    if (body.signoff === undefined) return [];
    const errors = (body.analysis?.findings ?? []).filter((f) => f.severity === "error");
    if (errors.length === 0) return [];
    return [
      {
        id: "GATE-002",
        severity: "error",
        path: "signoff",
        message: `the body is signed off while the recorded analysis still holds ${errors.length} error-severity ${
          errors.length === 1 ? "finding" : "findings"
        } (${errors
          .slice(0, 5)
          .map((f) => f.id)
          .join(", ")}); expected 0 — an artefact is signed after it passes, never before`,
      },
    ];
  },
};

const GATE_003: Check = {
  id: "GATE-003",
  severity: "error",
  run({ body }: CheckContext) {
    const s = body.signoff;
    if (s === undefined) return [];
    const held = s.approvers.map((a) => a.role);
    const missing = REQUIRED_ROLES.filter((r) => !held.includes(r));
    if (missing.length === 0) return [];
    return [
      {
        id: "GATE-003",
        severity: "error",
        path: "signoff.approvers",
        message: `the sign-off is held by ${
          held.length === 0 ? "nobody" : held.join(", ")
        }; expected all of ${REQUIRED_ROLES.join(", ")} — missing ${missing.join(", ")}`,
      },
    ];
  },
};

const GATE_006: Check = {
  id: "GATE-006",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    // The one refusal this whole phase exists for: an agent may draft, score,
    // ground and analyse a requirement set, and it may never approve one.
    (body.signoff?.approvers ?? []).forEach((a, i) => {
      if (a.kind === "human") return;
      out.push({
        id: "GATE-006",
        severity: "error",
        path: `signoff.approvers.${i}.kind`,
        message: `approver ${JSON.stringify(a.name)} for role ${JSON.stringify(
          a.role,
        )} signed as kind ${JSON.stringify(
          a.kind,
        )}; expected "human" — an agent cannot sign off its own requirements`,
      });
    });
    return out;
  },
};

export const PROVENANCE_CHECKS: Check[] = [
  CLARIFY_001,
  CLARIFY_002,
  CLARIFY_003,
  CLARIFY_004,
  CLARIFY_005,
  CLARIFY_006,
  TRACE_001,
  TRACE_002,
  TRACE_007,
  GATE_001,
  GATE_002,
  GATE_003,
  GATE_006,
];
