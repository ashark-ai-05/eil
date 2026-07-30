/**
 * Every word the elaboration loop says to a model, and nothing else.
 *
 * The rule the whole design rests on: **the model emits only bounded
 * judgments.** Each prompt below demands one JSON object with a fixed, tiny set
 * of keys, and every value that could be derived instead is derived instead —
 * magnitude and decision by `scoring.ts`, acceptance-criterion ids by
 * `nextAcId`, the verification of a quote by `ground.ts`. So the prompts do two
 * things at once: they ask for the judgment, and they say plainly that anything
 * else in the reply is discarded. A model that volunteers a decision has not
 * changed the artefact; it has wasted its own tokens.
 *
 * The instruction blocks are exported separately from the builders so that a
 * test can assert a prompt IS the block plus context, rather than asserting on a
 * string literal copied into the test — and so a reader can see the whole
 * instruction to a model on one screen, which is the only way anybody notices
 * that a prompt has quietly started asking for a decision.
 */

/** The context every prompt shares: which work item, and where in the tree. */
export interface NodeContext {
  /** the work item key, e.g. "PTR-401" */
  workItem: string;
  /** the work item's own title, verbatim from the tracker */
  title: string;
  /** the work item's own prose, verbatim; the only free text the model is given */
  brief: string;
  /** the statements from the root down to this node's parent */
  ancestors: string[];
  /** the statement being elaborated */
  statement: string;
}

/** Body text per document in a judge prompt: a bounded question about a little text. */
const MAX_BRIEF_CHARS = 4000;

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n[…truncated]`);

/**
 * The shared preamble. The work item's own words, then the path down the tree,
 * so a node deep in the tree is scored against what it is a part of rather than
 * as a free-standing sentence.
 */
function context(ctx: NodeContext): string {
  const trail =
    ctx.ancestors.length === 0
      ? "This is the top of the requirement tree."
      : `Where this sits in the requirement tree, outermost first:\n${ctx.ancestors
          .map((a, i) => `${"  ".repeat(i)}- ${a}`)
          .join("\n")}`;
  return `WORK ITEM ${ctx.workItem} — ${ctx.title}

${clip(ctx.brief.trim(), MAX_BRIEF_CHARS)}

${trail}

THE STATEMENT YOU ARE WORKING ON
${ctx.statement}`;
}

export const SCORE_PROMPT = `Score ONE requirement statement on TWO bands, and nothing else.

Reply with JSON only:
  {"unknowns": <band>, "complexity": <band>, "rationale": "<one line>"}

A band is exactly one of 1, 2, 3, 5, 8, 13, 21. There is no other admissible
value: 4 is not a band, and neither is 10.

- unknowns: how much about this statement NOBODY HAS DECIDED OR WRITTEN DOWN.
  Decisions still open, behaviour nobody has specified, a source of truth nobody
  has named, two documents that disagree. Score what is genuinely unresolved,
  not how hard the work looks.
- complexity: how much work and how many moving parts, ASSUMING every unknown
  above were answered this morning.
- rationale: one line, naming the largest single unknown.

Do NOT emit a magnitude. Do NOT emit a decision, and do not describe the
statement as a leaf, as needing decomposition, or as needing clarification. Both
are computed from your two bands by the pipeline, which discards anything you say
about them. Your two bands are the only thing you decide here.`;

export const CHILDREN_PROMPT = `Break ONE requirement statement into its parts.

Reply with JSON only:
  {"children": ["<statement>", "<statement>", ...]}

- Between 2 and 5 statements. One child is a rename, not a decomposition.
- Statements only. Do NOT emit ids, scores, bands, decisions, acceptance
  criteria, or nesting — the pipeline allocates ids and scores each child
  itself, and discards anything else in the reply.
- Each child must be a requirement in its own right: a sentence about what the
  system must do, in the vocabulary the work item and the organisation already
  use. Do not invent component names that are not in the material above.
- Together the children must cover the parent and must not overlap.`;

export const QUESTION_PROMPT = `Name the ONE question that, if a human answered it, would remove the most
uncertainty from this requirement statement.

Reply with JSON only:
  {"question": "<one question>"}

- A single interrogative sentence, self-contained: someone who has not read this
  prompt must be able to answer it. Name the concrete thing — the counterparty
  limit, the in-flight order, the amendment — rather than "the above".
- Ask for a fact or a decision that could already be written down somewhere in
  the organisation. Do not ask what the team would LIKE, or ask two questions at
  once.
- Do not answer it, and do not offer options. The pipeline searches the
  organisation's own writing for an answer, and escalates to a named human when
  it does not find one.`;

export const AC_PROMPT = `State how this requirement will be CHECKED.

Reply with JSON only:
  {"criteria": [{"stakeholder": "<role>", "given": "<...>", "when": "<...>",
                 "then": ["<outcome>", ...]}]}

- Between 1 and 4 criteria.
- Do NOT emit ids. The pipeline allocates them.
- stakeholder: the named role the outcome matters to, e.g. "Risk Ops".
- given / when: one clause each, in the present tense.
- then: one or more outcomes, each naming something a test could actually read —
  a status, a reason code, a count, a quantity with its unit, a rejected order.
  "works correctly" and "behaves as expected" are not outcomes.
- Never write TBD, TODO, "to be confirmed" or "decide later" anywhere in the
  reply. A criterion that defers is not a criterion; leave it out instead.`;

/**
 * Aboutness versus answerhood. Deliberately says the same thing as the default
 * judge in `ground.ts`, because both are prompts for the same bounded judgment —
 * this is the one the elaboration loop injects, so that every model call in a run
 * lands in `llm_calls` under one caller with its outcome recorded.
 */
export const JUDGE_PROMPT = `You decide ONE thing: do the documents below ANSWER the question?

Being ABOUT the question is not ANSWERING it. A document that restates the
question, records that a decision is still open, or says the matter is undecided
does NOT answer it — reply answers: false for those. Two documents that disagree
with each other do not answer it either.

Reply with JSON only:
  {"answers": boolean, "quote": string, "rationale": string}

- quote: the shortest run of text that carries the answer, copied from ONE
  document CHARACTER FOR CHARACTER. Empty string when answers is false. The
  quote is checked against the document it came from and discarded if it is not
  found there, so do not paraphrase, summarise, or stitch two passages together.
- rationale: one sentence.`;

export const scorePrompt = (ctx: NodeContext, resolved?: string): string =>
  `${SCORE_PROMPT}\n\n${context(ctx)}${
    resolved === undefined
      ? ""
      : `\n\nSINCE THE LAST SCORE, THIS WAS ESTABLISHED FROM THE ORGANISATION'S OWN WRITING\n${resolved}\n\nScore the statement again in the light of it.`
  }\n`;

export const childrenPrompt = (ctx: NodeContext): string =>
  `${CHILDREN_PROMPT}\n\n${context(ctx)}\n`;

export const questionPrompt = (ctx: NodeContext): string =>
  `${QUESTION_PROMPT}\n\n${context(ctx)}\n`;

export const acPrompt = (ctx: NodeContext): string => `${AC_PROMPT}\n\n${context(ctx)}\n`;

export const judgePrompt = (
  question: string,
  docs: { docId: string; title: string; body: string }[],
): string =>
  `${JUDGE_PROMPT}\n\nQUESTION\n${question}\n\nDOCUMENTS\n${docs
    .map((d) => `--- document ${d.docId} — ${d.title} ---\n${d.body}`)
    .join("\n\n")}\n`;
