/**
 * Content checks: AC (a leaf is only finished when it says how it will be
 * checked) and DEFER (a deferral is not a completion state).
 *
 * The observability heuristic and the deferral lexicon both come from
 * `scoring.js` / `constants.js`, so the checker and the assembler judge the
 * same prose by the same rule.
 *
 * Every message states the OBSERVED value and the EXPECTED one, because a
 * refusal is read aloud and has to explain itself without the source to hand.
 */
import type { Check, CheckContext } from "../analyse.js";
import { DEFERRAL_MARKERS } from "../constants.js";
import type { AcceptanceCriterion, Finding } from "../schema.js";
import { walk } from "../schema.js";
import { hasDeferral, isObservable } from "../scoring.js";

const AC_ID = /^AC-\d+$/;

const empty = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";

/** Every AC in the tree, with the node that carries it and its JSON path. */
function* criteria(body: CheckContext["body"]): Generator<{
  ac: AcceptanceCriterion;
  nodeId: string;
  path: string;
}> {
  for (const { node, path } of walk(body.tree)) {
    const acs = node.acceptanceCriteria ?? [];
    for (let i = 0; i < acs.length; i += 1)
      yield { ac: acs[i]!, nodeId: node.id, path: `${path}.acceptanceCriteria.${i}` };
  }
}

const AC_001: Check = {
  id: "AC-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { node, path } of walk(body.tree)) {
      if (node.decision !== "leaf") continue;
      const n = (node.acceptanceCriteria ?? []).length;
      if (n > 0) continue;
      out.push({
        id: "AC-001",
        severity: "error",
        path: `${path}.acceptanceCriteria`,
        message: `leaf "${node.id}" carries ${n} acceptance criteria; expected at least 1 — a requirement finalised without a way to check it is an opinion, not a requirement`,
      });
    }
    return out;
  },
};

const AC_002: Check = {
  id: "AC-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const blank = (where: string, field: string, id: string, value: unknown) => ({
      id: "AC-002",
      severity: "error" as const,
      path: where,
      message: `${id} has a blank ${field} (${JSON.stringify(
        value ?? null,
      )}); expected a non-empty Gherkin clause`,
    });
    for (const { ac, path } of criteria(body)) {
      if (empty(ac.given)) out.push(blank(`${path}.given`, "given", ac.id, ac.given));
      if (empty(ac.when)) out.push(blank(`${path}.when`, "when", ac.id, ac.when));
      // AC-003 owns an EMPTY then array; this is a blank entry inside one.
      (ac.then ?? []).forEach((t, i) => {
        if (empty(t)) out.push(blank(`${path}.then.${i}`, `then entry ${i}`, ac.id, t));
      });
    }
    return out;
  },
};

const AC_003: Check = {
  id: "AC-003",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { ac, path } of criteria(body)) {
      if ((ac.then ?? []).length > 0) continue;
      out.push({
        id: "AC-003",
        severity: "error",
        path: `${path}.then`,
        message: `${ac.id} states ${(ac.then ?? []).length} outcomes; expected at least 1 — a given/when with no then asserts nothing`,
      });
    }
    return out;
  },
};

const AC_004: Check = {
  id: "AC-004",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    const owner = new Map<string, string>();
    for (const { ac, nodeId, path } of criteria(body)) {
      if (!AC_ID.test(String(ac.id)))
        out.push({
          id: "AC-004",
          severity: "error",
          path: `${path}.id`,
          message: `acceptance criterion id ${JSON.stringify(
            ac.id ?? null,
          )} on node "${nodeId}" is malformed; expected the form AC-<n>, for example AC-7`,
        });
      const first = owner.get(ac.id);
      if (first === undefined) {
        owner.set(ac.id, nodeId);
        continue;
      }
      out.push({
        id: "AC-004",
        severity: "error",
        path: `${path}.id`,
        message: `acceptance criterion id "${ac.id}" appears on node "${nodeId}" and already on node "${first}"; expected every AC id to be used exactly once — traceability maps one id to one node`,
      });
    }
    return out;
  },
};

const AC_005: Check = {
  id: "AC-005",
  // WARNING, never an error: observability is an honestly-labelled heuristic
  // over a lexicon. It flags prose worth rewriting; it must not be the thing
  // that blocks a release, or the lexicon becomes something to game.
  severity: "warning",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { ac, path } of criteria(body)) {
      (ac.then ?? []).forEach((t, i) => {
        if (typeof t !== "string" || isObservable(t)) return;
        out.push({
          id: "AC-005",
          severity: "warning",
          path: `${path}.then.${i}`,
          message: `${ac.id} outcome ${JSON.stringify(
            t,
          )} names nothing a test could read; expected a quantity, a status, a code or another observable signal`,
        });
      });
    }
    return out;
  },
};

const AC_006: Check = {
  id: "AC-006",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { ac, path } of criteria(body)) {
      if (!empty(ac.stakeholder)) continue;
      out.push({
        id: "AC-006",
        severity: "error",
        path: `${path}.stakeholder`,
        message: `${ac.id} records stakeholder ${JSON.stringify(
          ac.stakeholder ?? null,
        )}; expected the named role the outcome matters to, for example "Risk Ops"`,
      });
    }
    return out;
  },
};

/**
 * WHICH marker was found, so the refusal quotes the artefact rather than reciting
 * the lexicon. `hasDeferral` from `scoring.js` remains the verdict — this only
 * ever runs once that has already said yes — so the two cannot disagree about
 * what counts as a deferral, under any edit to `DEFERRAL_MARKERS`.
 */
const markerIn = (text: string): string | null => {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  return DEFERRAL_MARKERS.find((m) => t.includes(m)) ?? null;
};

/**
 * The AUTHORED prose of the body, and nothing else. `grounding[].quote` is
 * deliberately absent: a quote is verbatim, it may legitimately contain someone
 * else's TODO, and refusing our artefact for a defect in a Confluence page we
 * merely cited would be indefensible. A quote that hedges is CLARIFY-006's
 * business — it has to carry a residual — never DEFER-001's.
 */
function* prose(
  body: CheckContext["body"],
): Generator<{ path: string; what: string; text: string }> {
  const say = (path: string, what: string, text: unknown) =>
    typeof text === "string" && text.length > 0 ? [{ path, what, text }] : [];

  yield* say("metadata.title", "the title", body.metadata.title);

  for (const { node, path } of walk(body.tree)) {
    yield* say(`${path}.statement`, `the statement of node "${node.id}"`, node.statement);
    yield* say(`${path}.score.note`, `the score note on node "${node.id}"`, node.score.note);
    for (let i = 0; i < node.scoreHistory.length; i += 1)
      yield* say(
        `${path}.scoreHistory.${i}.note`,
        `the note on pass ${i} of node "${node.id}"`,
        node.scoreHistory[i]?.note,
      );
    const acs = node.acceptanceCriteria ?? [];
    for (let a = 0; a < acs.length; a += 1) {
      const ac = acs[a]!;
      const at = `${path}.acceptanceCriteria.${a}`;
      yield* say(`${at}.given`, `the given of ${ac.id}`, ac.given);
      yield* say(`${at}.when`, `the when of ${ac.id}`, ac.when);
      for (let t = 0; t < (ac.then ?? []).length; t += 1)
        yield* say(`${at}.then.${t}`, `outcome ${t} of ${ac.id}`, ac.then[t]);
    }
  }

  for (let ci = 0; ci < body.clarifications.length; ci += 1) {
    const c = body.clarifications[ci]!;
    const at = `clarifications.${ci}`;
    yield* say(`${at}.question`, `the question of ${c.id}`, c.question);
    for (let o = 0; o < c.options.length; o += 1) {
      const opt = c.options[o]!;
      yield* say(`${at}.options.${o}.text`, `option ${opt.id} of ${c.id}`, opt.text);
      yield* say(
        `${at}.options.${o}.implication`,
        `the implication of option ${opt.id} of ${c.id}`,
        opt.implication,
      );
    }
    yield* say(`${at}.resultingDetail`, `the recorded answer to ${c.id}`, c.resultingDetail);
  }

  for (let ri = 0; ri < body.residuals.length; ri += 1) {
    const r = body.residuals[ri]!;
    yield* say(`residuals.${ri}.statement`, `the statement of residual ${r.id}`, r.statement);
    yield* say(`residuals.${ri}.mitigation`, `the mitigation of residual ${r.id}`, r.mitigation);
  }
}

const DEFER_001: Check = {
  id: "DEFER-001",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    for (const { path, what, text } of prose(body)) {
      if (!hasDeferral(text)) continue;
      const marker = markerIn(text) ?? "a deferral marker";
      out.push({
        id: "DEFER-001",
        severity: "error",
        path,
        message: `${what} defers a decision — it contains "${marker}" (${JSON.stringify(
          text.length > 120 ? `${text.slice(0, 120)}…` : text,
        )}); expected a decision, a clarification, or a residual accepted by a named human, none of which is the word "${marker}"`,
      });
    }
    return out;
  },
};

const DEFER_002: Check = {
  id: "DEFER-002",
  severity: "error",
  run({ body }: CheckContext) {
    const out: Finding[] = [];
    // The recorded-decision fields specifically. DEFER-001 also covers these, on
    // purpose: a deferral in the answer to a question that was already asked, or
    // in the mitigation of an uncertainty someone has already signed for, is the
    // worst place in the artefact for one, and it gets named twice.
    const record = (path: string, what: string, text: unknown) => {
      if (typeof text !== "string" || text.length === 0) return;
      if (!hasDeferral(text)) return;
      const marker = markerIn(text) ?? "a deferral marker";
      out.push({
        id: "DEFER-002",
        severity: "error",
        path,
        message: `${what} is a recorded decision, yet it contains "${marker}" (${JSON.stringify(
          text.length > 120 ? `${text.slice(0, 120)}…` : text,
        )}); expected the decision that was actually taken — a resolution that defers is not a resolution`,
      });
    };
    body.clarifications.forEach((c, i) =>
      record(
        `clarifications.${i}.resultingDetail`,
        `the resolution recorded for ${c.id}`,
        c.resultingDetail,
      ),
    );
    body.residuals.forEach((r, i) =>
      record(
        `residuals.${i}.mitigation`,
        `the mitigation recorded for residual ${r.id}`,
        r.mitigation,
      ),
    );
    return out;
  },
};

export const CONTENT_CHECKS: Check[] = [
  AC_001,
  AC_002,
  AC_003,
  AC_004,
  AC_005,
  AC_006,
  DEFER_001,
  DEFER_002,
];
