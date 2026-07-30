/**
 * Builds `demo/PTR-401.replay.json` — the recorded model run the demo replays.
 *
 * ## What this file is, in one paragraph
 *
 * Every bounded judgment in the pack was WRITTEN BY HAND, here, while this demo
 * was built. No model produced them, on this machine or anywhere else: `amp` is
 * non-functional here and `copilot` is not installed. The pack says so in its
 * own `provider` and `note` fields, `model` is null because no model id would be
 * true, and `FixtureProvider` stamps every replayed artefact
 * `generator.provenance: "replay"` so the projection cannot read as a live run.
 * That labelling is the whole licence for this file to exist.
 *
 * ## What is NOT authored here
 *
 * Only the five bounded judgments the loop is allowed to ask for: two scoring
 * bands, one question, a list of child statements, a set of acceptance criteria,
 * and an answers/quote ruling on whether a document answers a question. Every
 * other thing in the artefact is computed by the pipeline from those, against
 * the real corpus:
 *
 *   - magnitude, zone and decision   scoring.ts, from the two bands
 *   - which documents are read        real retrieval, real confidence arithmetic
 *   - whether a citation stands       the quote is re-read out of the catalog
 *   - grounded vs escalated           the cascade, not this file
 *   - every [G] field and the verdict assemble.ts and the 46 checks
 *
 * The judge replies below are deliberately written as a real judge behaves: each
 * one names the quote it would give, and answers `false` unless that exact text
 * is in the documents the retriever actually put in front of it. So a quote here
 * cannot be a fabrication that happens to pass — if retrieval stops returning
 * the document, the run escalates to a human instead of citing thin air.
 *
 *   pnpm pack:build          rebuild the pack (needs the demo catalog ingested)
 *
 * Rebuild it whenever `ts/reqs/prompt.ts` changes: replies are keyed by the
 * sha256 of the exact prompt, so a reworded instruction block retires the pack.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../ts/db.js";
import type { CompleteOptions, LLMResult, Provider } from "../ts/llm/index.js";
import { elaborate } from "../ts/reqs/elaborate.js";
import {
  AC_PROMPT,
  CHILDREN_PROMPT,
  JUDGE_PROMPT,
  QUESTION_PROMPT,
  SCORE_PROMPT,
} from "../ts/reqs/prompt.js";
import { localViewer } from "../ts/search.js";

export const PACK_PATH = "demo/PTR-401.replay.json";
export const WORK_ITEM = "PTR-401";

/** The work item's own title, which the loop uses as the root statement. */
const ROOT = "PTR-401: Intraday PSR limit amendment";

const S1 =
  "Risk Ops can raise and approve a counterparty limit amendment that takes effect the same day.";
const S2 =
  "An approved amendment reaches every gateway's limit snapshot on the day it is approved.";
const S3 =
  "Orders already working at the venue are treated according to an agreed rule when a limit is reduced.";
const S4 =
  "A presettlement credit check that cannot be evaluated during an amendment rejects the order.";
const S21 =
  "psr-limits publishes each amended counterparty record and every gateway replaces its entry in place.";
const S22 = "The gateway acts on an amended limit inside the agreed end-to-end refresh time.";
const S23 =
  "Intraday utilisation is measured against the amended limit without waiting for the overnight netting cycle.";
const S231 = "Utilisation accumulated intraday is released only by the overnight netting cycle.";
const S232 =
  "An increased limit gives the counterparty headroom as soon as the amendment is approved.";

/** The three questions, and the node each belongs to. */
const Q_REFRESH = "What end to end time was the refresh aiming for?";
const Q_NETTING =
  "Is netting applied intraday, or does utilisation only accumulate until the overnight batch has run?";
const Q_INFLIGHT =
  "What happens to orders already working at the venue when a counterparty limit is reduced?";

interface Band {
  unknowns: number;
  complexity: number;
  rationale: string;
}

/**
 * The two bands per statement. The SHAPE OF THE TREE FALLS OUT OF THESE — the
 * pipeline picks leaf, decompose or clarify from them and this file never says
 * which. So the branches nobody has written anything about score high and get
 * taken apart or asked about; the ones the runbooks already answer score low and
 * stop immediately. That is why the leaves do not all sit at one depth.
 */
const FIRST_PASS: Record<string, Band> = {
  [ROOT]: {
    unknowns: 8,
    complexity: 8,
    rationale:
      "nobody has decided what happens to an order already working at the venue when the limit comes down",
  },
  [S1]: {
    unknowns: 2,
    complexity: 2,
    rationale:
      "the two-person amendment path is written down and credit-admin enforces it, so almost nothing here is open",
  },
  [S2]: {
    unknowns: 5,
    complexity: 5,
    rationale:
      "the refresh path is described in somebody's working notes rather than a design, and its timing is unmeasured",
  },
  [S3]: {
    unknowns: 8,
    complexity: 5,
    rationale:
      "no source states what becomes of an order already at the venue when its counterparty's limit is reduced",
  },
  [S4]: {
    unknowns: 2,
    complexity: 2,
    rationale:
      "fail closed on an unevaluated control is stated as non-negotiable, so the behaviour is not in doubt",
  },
  [S21]: {
    unknowns: 2,
    complexity: 2,
    rationale:
      "the per-counterparty publish and in-place replace is agreed and recorded, leaving only the ordering rule",
  },
  [S22]: {
    unknowns: 5,
    complexity: 2,
    rationale:
      "the end-to-end refresh time is the largest unknown: the only figure anyone has written hedges itself",
  },
  [S23]: {
    unknowns: 5,
    complexity: 5,
    rationale:
      "whether intraday utilisation can come down at all before the overnight cycle is not settled anywhere",
  },
  [S231]: {
    unknowns: 2,
    complexity: 2,
    rationale:
      "the accumulate-only behaviour is now stated plainly and the only work is holding the desk to it",
  },
  [S232]: {
    unknowns: 1,
    complexity: 2,
    rationale:
      "an increase simply raises the number the check compares against, and the publish path is the same one",
  },
};

/**
 * The second pass on a node whose question the corpus answered. Scored against
 * what was actually found, which is why the unknowns come down — and why
 * SCORE-006 accepts the leaf below rather than refusing it.
 */
const SECOND_PASS: Record<string, Band> = {
  [S22]: {
    unknowns: 3,
    complexity: 2,
    rationale:
      "a 250ms target now exists, but its own author records that he never measured it, so it is a target and not a fact",
  },
  [S23]: {
    unknowns: 3,
    complexity: 5,
    rationale:
      "netting is settled — end of day only — so what is left is the accumulate-only behaviour and the increase case",
  },
};

const CHILDREN: Record<string, string[]> = {
  [ROOT]: [S1, S2, S3, S4],
  [S2]: [S21, S22, S23],
  [S23]: [S231, S232],
};

const QUESTIONS: Record<string, string> = {
  [S22]: Q_REFRESH,
  [S23]: Q_NETTING,
  [S3]: Q_INFLIGHT,
};

interface RawCriterion {
  stakeholder: string;
  given: string;
  when: string;
  then: string[];
}

const CRITERIA: Record<string, RawCriterion[]> = {
  [S1]: [
    {
      stakeholder: "Risk Ops",
      given: "an amendment raised in credit-admin by one Risk Ops user",
      when: "a second, different Risk Ops user approves it",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: [
        "credit-admin records the amendment as approved and hands it to psr-limits the same day",
        "the approve action is refused with a separation-of-duties reason code when the approver is the user who raised it",
      ],
    },
  ],
  [S4]: [
    {
      stakeholder: "Compliance",
      given:
        "a gateway that cannot evaluate the presettlement credit check while an amendment is being applied",
      when: "an order arrives for that counterparty",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: [
        "the order is rejected with a credit-unavailable reason code",
        "the rejection records which control could not be evaluated",
      ],
    },
  ],
  [S21]: [
    {
      stakeholder: "Platform on-call",
      given: "an approved amendment for one counterparty",
      when: "psr-limits publishes the amended record",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: [
        "every gateway snapshot holds the new limit for that counterparty and no other counterparty's entry changes",
        "a publish older than the record already held is dropped, and the snapshot version does not go backwards",
      ],
    },
  ],
  [S22]: [
    {
      stakeholder: "Risk Ops",
      given: "an amendment approved in credit-admin",
      when: "psr-limits publishes it to the gateways",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: [
        "the gateway evaluates the next order for that counterparty against the amended limit within 250ms of approval",
        "the age of each gateway's snapshot is exported as a metric",
      ],
    },
  ],
  [S231]: [
    {
      stakeholder: "Risk Ops",
      given: "a counterparty whose utilisation has accumulated during the day",
      when: "a closing trade for that counterparty is executed before the overnight batch",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: [
        "the utilisation counter for that counterparty does not decrease",
        "the headroom returned to the desk is unchanged by the closing trade",
      ],
    },
  ],
  [S232]: [
    {
      stakeholder: "Front office",
      given: "a counterparty sitting at its current limit",
      when: "an increase is approved and published",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: [
        "an order rejected for credit a moment earlier is accepted once the gateway holds the increased limit",
        "the rejection and the acceptance are both logged with the limit version each was evaluated against",
      ],
    },
  ],
};

/**
 * What a judge would quote, per question — and nothing about which document it
 * comes from. The provider below answers `true` only when the exact text is
 * present in the documents retrieval actually supplied, so attribution is
 * decided by the pipeline verifying the quote, never by this file naming a
 * source. `Q_INFLIGHT` has no entry at all: the corpus does not answer it, and
 * PTR-420 — which tops retrieval for it — only restates it.
 */
const QUOTES: Record<string, string> = {
  [Q_REFRESH]:
    "Was aiming for 250ms end to end from the change landing in credit-admin to the gateway acting on it, and I think we got roughly there, but I haven't measured recently.",
  [Q_NETTING]:
    "Netting is applied end of day only, never intraday. Intraday, utilisation only goes up: every order adds its contribution and nothing comes off until the overnight batch has run.",
};

const RATIONALES: Record<string, string> = {
  [Q_REFRESH]:
    "one page states a target end-to-end refresh time and hedges it in the same sentence",
  [Q_NETTING]: "the limit model notes state plainly that netting is end of day only",
  [Q_INFLIGHT]:
    "the only document on this is a ticket that records the question as undecided, which is being about it rather than answering it",
};

/**
 * How long the authoring step spends on each kind of judgment. This is a PACE,
 * not a claim about any model: the recorder measures whatever this really takes,
 * and the pack's note says exactly that. It exists so a replayed run has the
 * rhythm of a run rather than finishing before the room has read the first line.
 */
const PACE = { score: 500, children: 1000, question: 450, criteria: 1200, judge: 900 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The statement a node prompt is working on, verbatim from the prompt itself. */
function statementOf(prompt: string): string {
  const marker = "THE STATEMENT YOU ARE WORKING ON\n";
  const at = prompt.indexOf(marker);
  if (at < 0) throw new Error("no statement in prompt");
  return prompt
    .slice(at + marker.length)
    .split("\n")[0]!
    .trim();
}

function questionOf(prompt: string): string {
  const marker = "\nQUESTION\n";
  const at = prompt.indexOf(marker);
  if (at < 0) throw new Error("no question in prompt");
  return prompt
    .slice(at + marker.length)
    .split("\n")[0]!
    .trim();
}

const need = <T>(table: Record<string, T>, key: string, what: string): T => {
  const value = table[key];
  if (value === undefined) throw new Error(`nothing authored for the ${what} of: ${key}`);
  return value;
};

/** Whitespace-normalised containment — exactly how the cascade verifies a quote. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The authoring provider. It is a `Provider` like any other, so the run that
 * produces the pack goes through the same loop, the same cascade and the same
 * gate as a run against a real model.
 */
export function authoringProvider(): Provider {
  return {
    name: "hand-authored-during-build",
    async complete(prompt: string, _opts: CompleteOptions = {}): Promise<LLMResult> {
      const reply = async (kind: keyof typeof PACE, body: unknown): Promise<LLMResult> => {
        await sleep(PACE[kind]);
        return { text: JSON.stringify(body), provider: "hand-authored-during-build", model: null };
      };

      if (prompt.includes(AC_PROMPT)) {
        return reply("criteria", { criteria: need(CRITERIA, statementOf(prompt), "criteria") });
      }
      if (prompt.includes(CHILDREN_PROMPT)) {
        return reply("children", { children: need(CHILDREN, statementOf(prompt), "children") });
      }
      if (prompt.includes(QUESTION_PROMPT)) {
        return reply("question", { question: need(QUESTIONS, statementOf(prompt), "question") });
      }
      if (prompt.includes(JUDGE_PROMPT)) {
        const question = questionOf(prompt);
        const quote = QUOTES[question] ?? "";
        // A judge that cannot find its own words in what it was given says no.
        // This is what stops an authored quote from ever being a fabrication:
        // if retrieval did not supply the document, the run escalates.
        const answers = quote !== "" && flat(prompt).includes(flat(quote));
        return reply("judge", {
          answers,
          quote: answers ? quote : "",
          rationale: RATIONALES[question] ?? "no document supplied answers the question",
        });
      }
      if (prompt.includes(SCORE_PROMPT)) {
        const statement = statementOf(prompt);
        const again = prompt.includes("SINCE THE LAST SCORE");
        const band = again
          ? need(SECOND_PASS, statement, "second scoring pass")
          : need(FIRST_PASS, statement, "scoring pass");
        return reply("score", band);
      }
      throw new Error(`unrecognised prompt: ${prompt.slice(0, 80)}`);
    },
  };
}

export const PACK_NOTE = [
  "Hand-authored during the build of this demo, not a captured run of a production model.",
  "No model produced these replies — `amp` was non-functional and `copilot` was not installed on",
  "the machine this was built on — which is why `model` is null and `provider` says what it says.",
  "Only the five bounded judgments the loop asks for are authored here: two scoring bands, one",
  "question, the child statements, the acceptance criteria, and the answers/quote ruling. Retrieval,",
  "the confidence arithmetic, quote verification against the ingested corpus, the assembler and all",
  "46 gate checks ran for real. The recorded latencies are the authoring step's own measured think",
  "time, kept so a replay has the rhythm of a run; they are not any model's response times.",
].join(" ");

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "eil-pack-"));
  const client = await connect();
  try {
    const viewer = localViewer();
    const { makeDocResolver } = await import("../ts/reqs/io.js");
    const body = await elaborate(WORK_ITEM, {
      client,
      viewer,
      provider: authoringProvider(),
      record: PACK_PATH,
      recordNote: PACK_NOTE,
      out: join(scratch, "PTR-401.reqs.json"),
      resolveDoc: makeDocResolver(client, viewer),
    });
    const cov = body.coverage;
    console.log(`wrote ${PACK_PATH}`);
    console.log(
      `  ${cov?.leaves} leaves · ${cov?.acs} ACs · ${cov?.grounded} grounded · ${cov?.escalated} escalated`,
    );
    const errors = (body.analysis?.findings ?? []).filter((f) => f.severity === "error");
    console.log(`  the recording run itself: ${errors.length} error-severity findings`);
  } finally {
    await client.end();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
