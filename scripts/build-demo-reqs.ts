/**
 * Builds `demo/PTR-401.reqs.json` and its projection, end to end, from the real
 * pipeline:
 *
 *   1. `eil reqs elaborate PTR-401` — the actual CLI, with EIL_LLM_FIXTURE
 *      pointed at the recorded pack. Real retrieval, real resolution cascade,
 *      real citation verification, real gate. The artefact it writes is REFUSED,
 *      and correctly so: it carries a question only a human can answer, and a
 *      citation from a source that hedges.
 *   2. the human pass below — the decisions this phase structurally cannot make
 *      for itself.
 *   3. `eil reqs render` — the HTML projection at demo/PTR-401.html.
 *
 *     pnpm demo:reqs                  rebuild the artefact and the page
 *     pnpm demo:reqs --rebuild-pack   re-author the recorded run first
 *
 * ## Why step 2 exists at all
 *
 * `ts/reqs/elaborate.ts` cannot write a sign-off — there is no code in it that
 * can, and that is the single property the whole phase is built to hold. It
 * cannot accept a residual either, because a residual is only ever carried on a
 * named human's authority, and it cannot answer an escalation, because the point
 * of escalating is that nothing in the corpus answers it.
 *
 * So the refusal in step 1 is a WORKLIST, and this step is the humans working
 * it: three findings, three human acts, recorded with the name of the person who
 * performed each. Nothing here touches the tree, the scores, the citations or
 * any generated field — those all come out of step 1 and are recomputed by the
 * assembler here, so a value edited by hand would be caught by META-002 exactly
 * as a tamper would.
 */
import { spawnSync } from "node:child_process";
import { connect } from "../ts/db.js";
import { analyse } from "../ts/reqs/analyse.js";
import { assemble } from "../ts/reqs/assemble.js";
import { loadReqs, makeDocResolver, saveReqs } from "../ts/reqs/io.js";
import type { Clarification, Finding, ReqsBody, Residual, Signoff } from "../ts/reqs/schema.js";
import { walk } from "../ts/reqs/schema.js";
import { localViewer } from "../ts/search.js";
import { PACK_PATH, WORK_ITEM } from "./build-replay-pack.js";

const OUT = "demo/PTR-401.reqs.json";
const PAGE = "demo/PTR-401.html";

/** The node whose citation hedges, and the node whose question escalated. */
const HEDGED_NODE = "REQ-ROOT.2.2";
const ESCALATED_QUESTION = "orders already working at the venue";

const run = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  console.log(`$ pnpm eil ${argv.join(" ")}`);
  const r = spawnSync("pnpm", ["-s", "eil", ...argv], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`\n${argv[0]} failed with status ${r.status}`);
    process.exit(r.status ?? 1);
  }
};

/**
 * d.mercer is PTR-401's reporter, and the human the cascade escalated to. The
 * answer is recorded as a HUMAN decision — `resolvedFrom: "human"`, no citation
 * and no pretence of one — because nothing in the corpus says this. PTR-420 asks
 * the same question and records that it is still undecided.
 */
function answerTheEscalation(c: Clarification, at: string): Clarification {
  return {
    ...c,
    answer: {
      freetext:
        "Orders already working at the venue complete against the limit that was in force when " +
        "they were accepted; the reduced limit binds every order received after the amendment is " +
        "approved. Risk and compliance settled this together, and the decision is to be written " +
        "back onto PTR-420, which currently records none.",
    },
    answeredAt: at,
    resolvedFrom: "human",
    resultingDetail:
      "Answered by d.mercer, the work item's reporter, on the authority of risk and compliance. " +
      "No document in the corpus states this, so this answer carries no citation and none is " +
      "implied — it is a decision that was taken, recorded as one.",
  };
}

/**
 * The hedged citation. The grounding stands: ptrd-2 really does state a 250ms
 * target, and the quote is verbatim. What may not happen is that target being
 * laundered into a fact, because the same sentence says its author never
 * measured it. So a named human carries the uncertainty instead, which is what
 * CLARIFY-006 and UNCERT-001 between them are asking for.
 */
function residual(at: string): Residual {
  return {
    id: "RU-1",
    kind: "ResidualUncertainty",
    nodeId: HEDGED_NODE,
    statement:
      "The 250ms end-to-end refresh target is carried on a page of working notes whose author " +
      "wrote, in the same sentence, that he thinks it was met and has not measured it recently. " +
      "Nothing else in the corpus states a measured figure, so the build starts against a target " +
      "nobody has confirmed.",
    mitigation:
      "Measure the credit-admin to gateway refresh on the current kit before build starts and " +
      "replace the target with the measured figure. s.iyer owns the publish-ordering write-up " +
      "this depends on.",
    acceptedBy: { kind: "human", name: "s.iyer" },
    acceptedAt: at,
  };
}

/**
 * Three humans, three roles, and a result of "partial" — because two of these
 * requirements rest on an unconfirmed number and a decision taken outside the
 * corpus. This phase gates a requirement set; it never certifies one as passed,
 * and GATE-001 refuses the word.
 */
function signoff(at: string): Signoff {
  return {
    result: "partial",
    approvers: [
      { name: "d.mercer", role: "PO", kind: "human", at },
      { name: "s.iyer", role: "TechLead", kind: "human", at },
      { name: "n.okafor", role: "QA", kind: "human", at },
    ],
  };
}

/** The worklist the refusal named: answer the escalation, carry the residual. */
function workTheRefusal(body: ReqsBody, at: string): ReqsBody {
  const clarifications = body.clarifications.map((c) =>
    c.answeredBy?.kind === "human" && c.question.includes(ESCALATED_QUESTION)
      ? answerTheEscalation(c, at)
      : c,
  );
  if (!clarifications.some((c) => c.resolvedFrom === "human")) {
    throw new Error(`no escalated clarification about "${ESCALATED_QUESTION}" to answer`);
  }

  const tree = structuredClone(body.tree);
  let attached = false;
  for (const { node } of walk(tree)) {
    if (node.id !== HEDGED_NODE) continue;
    node.residualRef = "RU-1";
    attached = true;
  }
  if (!attached) throw new Error(`node ${HEDGED_NODE} is not in the tree`);

  return {
    ...body,
    metadata: { ...body.metadata, updatedAt: at },
    tree,
    clarifications,
    residuals: [residual(at)],
  };
}

function report(stage: string, result: { checksRun: number; findings: Finding[]; ok: boolean }) {
  const errors = result.findings.filter((f) => f.severity === "error").length;
  console.log(
    `\n${stage}: ${result.checksRun} checks run   ${errors} errors   ` +
      `${result.findings.length - errors} warnings   ${result.ok ? "PASSED" : "REFUSED"}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--rebuild-pack")) {
    const { spawnSync: sh } = await import("node:child_process");
    console.log("$ pnpm pack:build");
    const r = sh("pnpm", ["-s", "pack:build"], { stdio: "inherit", env: process.env });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }

  // Step 1 — the real CLI, replaying the recorded judgments. This exits 0 and
  // writes a REFUSED artefact, which is the honest output and the input to the
  // human pass below.
  run(["reqs", "elaborate", WORK_ITEM, "--out", OUT], { EIL_LLM_FIXTURE: PACK_PATH });

  // Step 2 — the human pass, in the order the gate insists on: the work first,
  // then the gate, and only then the signatures. GATE-002 refuses an artefact
  // signed while its own recorded analysis still holds errors, so signing before
  // re-running the gate would be caught here rather than glossed over.
  const client = await connect();
  try {
    const viewer = localViewer();
    const gate = { resolveDoc: makeDocResolver(client, viewer) };
    const at = new Date().toISOString();

    // 2a — the two human acts the refusal asked for. The assembler is still the
    // only writer of generated fields, so anything edited by hand here would be
    // caught by META-002 exactly as a tamper would.
    const worked = assemble(workTheRefusal(await loadReqs(OUT), at));
    const before = await analyse(worked, gate);
    worked.analysis = { ranAt: at, checksRun: before.checksRun, findings: before.findings };
    report("after the human pass", before);
    if (!before.ok) {
      for (const f of before.findings) console.error(`  ${f.id}  ${f.path}  ${f.message}`);
      process.exitCode = 1;
      return;
    }

    // 2b — signed, now that it passes, and the gate run once more over the
    // signed body so the analysis recorded in the file is the analysis of the
    // file as it stands.
    const signed = assemble({ ...worked, signoff: signoff(at) });
    const after = await analyse(signed, gate);
    signed.analysis = { ranAt: at, checksRun: after.checksRun, findings: after.findings };
    await saveReqs(OUT, signed);
    report("signed", after);
    if (!after.ok) {
      for (const f of after.findings) console.error(`  ${f.id}  ${f.path}  ${f.message}`);
      process.exitCode = 1;
      return;
    }
  } finally {
    await client.end();
  }

  // Step 3 — the projection, which runs the gate again and stamps the page.
  run(["reqs", "render", OUT, "--out", PAGE]);
}

await main();
