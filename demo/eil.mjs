#!/usr/bin/env node
/**
 * The knowledge plane, in fifteen minutes, to a room that already has MCP
 * servers for Confluence, Jira and Bitbucket.
 *
 *   node demo/eil.mjs
 *
 * That is the whole invocation. No Docker, no Postgres, no VPN, no credentials:
 * the backend is PGlite, which is real Postgres compiled to WASM and loaded out
 * of node_modules, and the corpus is the local fixture set plus the synthetic
 * service repo in demo/repo/.
 *
 * This is NOT the requirements-gate demo. That one is demo/run.mjs and it makes
 * a different argument. This one is about the layer underneath: ingestion,
 * indexing, retrieval, cost, governance, observability.
 *
 * The argument it has to win, in the first ninety seconds, is "we already have
 * this" — so step 1 asks one question the way it gets asked today, of one
 * system at a time, and then asks it of everything.
 *
 * Every step prints the command before it runs it. An audience that sees output
 * arrive with no visible cause does not believe the output.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

if (has("help")) {
  console.log(`
eil — the knowledge plane, in fifteen minutes

  node demo/eil.mjs

Options:
  --data <dir>     PGlite directory (default: .eil-demo)
  --keep           do not wipe --data first (resume a part-built run)
  --skip-embed     skip the local embedding model; search runs lexical-only
  --pause          wait for Enter between steps, so you control the pace

The whole run is local. No network, no credentials, no Atlassian instance.
`);
  process.exit(0);
}

const DATA = flag("data", ".eil-demo");
const REPO_NAME = "ptr-services";
const ENG = "grp-engineering";
const RISK = "grp-risk-ops";

/**
 * The question the demo is built around.
 *
 * Its answer is genuinely distributed, which is the entire point: Confluence
 * says a control that cannot be evaluated has not passed, PTR-415 carries the
 * threshold everyone agreed on, and creditCheck.ts is the line that enforces
 * it. Ask any one system and you get a defensible, incomplete answer.
 */
const QUESTION = "how stale can the presettlement view be before an order is rejected";

/** For the governance step. The page holds real counterparty credit lines. */
const SENSITIVE = "what is CPTY-ALPHA presettlement limit";

const env = { ...process.env, EIL_DATABASE_URL: `pglite://${DATA}` };
let stepNo = 0;

function pause() {
  if (!has("pause")) return;
  spawnSync("bash", ["-c", 'read -r -p "  ↵ " _ < /dev/tty'], { stdio: "inherit" });
}

/**
 * One heading, one or more commands beneath it.
 *
 * `say` is the line to deliver while it runs — kept here rather than only in
 * the narration file so that a presenter reading the terminal is never without
 * the point of the step they are looking at.
 */
function step(title, say, cmds, { optional = false, extraEnv = {} } = {}) {
  stepNo += 1;
  console.log(`\n\x1b[1m── ${stepNo}. ${title}\x1b[0m`);
  console.log(`   \x1b[3m${say}\x1b[0m`);
  let ok = true;
  for (const { show, bin, argv, env: cmdEnv } of cmds) {
    console.log(`   \x1b[2m$ ${show}\x1b[0m\n`);
    const r = spawnSync(bin[0], [...bin.slice(1), ...argv], {
      stdio: "inherit",
      env: { ...env, ...extraEnv, ...(cmdEnv ?? {}) },
    });
    if (r.status === 0) continue;
    ok = false;
    if (!optional) {
      console.error("\nStep failed. Fix it and re-run, or pass --keep to resume from here.");
      process.exit(r.status ?? 1);
    }
  }
  pause();
  return ok;
}

const eil = (argv, cmdEnv) => ({
  show: `eil ${argv.join(" ")}`,
  bin: ["pnpm", "-s", "eil"],
  argv,
  ...(cmdEnv ? { env: cmdEnv } : {}),
});

const run = (title, say, argv, opts) => step(title, say, [eil(argv)], opts);

// A stale clone cache makes `git clone` fail with a raw git error and no
// recovery, which is a poor thing to debug in front of people.
if (existsSync(".eil-repos")) rmSync(".eil-repos", { recursive: true, force: true });
if (!has("keep") && existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });

console.log(`\x1b[1mEIL — the knowledge plane\x1b[0m`);
console.log(`backend: PGlite at ${DATA}. No server, no Docker, no admin rights.`);
console.log("corpus:  demo/fixtures/ + demo/repo/. Nothing in this run touches the network.\n");

// ── 2. Ingestion ───────────────────────────────────────────────────────────
// Deliberately BEFORE the opening question, because there has to be an index
// to ask. The narration opens on step 3; steps 1 and 2 are the stage being set,
// and a presenter who wants the room watching from the first command should
// run this much beforehand and start the talk at step 3.

run(
  "Create the catalog",
  "Nineteen migrations into a Postgres running inside this Node process. The same schema runs unchanged against a real cluster.",
  ["db", "migrate"],
);

const FIXTURES = "demo/fixtures";
const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .sort();
step(
  "Ingest Confluence and Jira",
  "Eight pages and five tickets. Ingestion normalises a fixture and a live sync into the same canonical document, so everything downstream is the production code path.",
  files.map((f) =>
    eil([
      "ingest",
      f.includes("ptrd-") ? "confluence" : "jira",
      "--fixture",
      join(FIXTURES, f),
    ]),
  ),
);

run(
  "Ingest the repository",
  "Cloned and walked. Code takes the overlapping line-window chunker — 60 lines, 10 of overlap — so an answer straddling a boundary is still found, and still cites a line range.",
  [
    "ingest",
    "repo",
    ".",
    "--subpath",
    "demo/repo",
    "--name",
    REPO_NAME,
    "--include",
    "**/*.ts",
    "--acl-group",
    ENG,
  ],
);

run("Compute the statistics", "Document frequency, N and average length — the ranking groundwork.", [
  "stats:refresh",
]);

if (!has("skip-embed")) {
  run(
    "Embed, locally",
    "A vendored ONNX model, on this laptop. Nothing is sent anywhere and no per-query cost is incurred. If the model is missing this step is skipped and search runs lexical-only.",
    ["embed", "backfill"],
    { optional: true },
  );
}

// ── 3. Ingest again, to show what incremental means ────────────────────────

step(
  "Ingest it all again",
  "The second run is a diff, not a re-read. Prose is hash-gated so nothing changed; the repo short-circuits on the commit SHA before it lists a single file.",
  [
    ...files
      .slice(0, 3)
      .map((f) =>
        eil(["ingest", f.includes("ptrd-") ? "confluence" : "jira", "--fixture", join(FIXTURES, f)]),
      ),
    eil([
      "ingest",
      "repo",
      ".",
      "--subpath",
      "demo/repo",
      "--name",
      REPO_NAME,
      "--include",
      "**/*.ts",
      "--acl-group",
      ENG,
    ]),
  ],
);

// ── 4. What is in there, and what scores it ────────────────────────────────

run(
  "Look at the index",
  "Unit-normalized float4[], so cosine is a plain dot product Postgres computes itself. The extension list is read out of pg_extension and it is empty. There is no vector database here.",
  ["index:stats"],
);

// ── 5. The opening question — one system at a time, then all of them ───────

run(
  "Ask it of Confluence alone",
  "This is the shape of asking today. You get the rule — a control that cannot be evaluated has not passed — and nothing else. It is correct, and it is not an answer.",
  ["search", QUESTION, "--source", "confluence", "--limit", "3"],
);

run(
  "Ask it of Jira alone",
  "The ticket where the threshold was agreed. Again true, again partial.",
  ["search", QUESTION, "--source", "jira", "--limit", "3"],
);

run(
  "Now ask all of it",
  "Four lexical arms — strict and loose, over prose and over code — plus a vector arm, fused by reciprocal rank. The rule, the agreed number, and the line that enforces it. Point at `executor`: those are the arms that actually contributed. No model ran.",
  ["search", QUESTION, "--limit", "6"],
);

run(
  "Ask it again",
  "Same query, same corpus, same order. Every time. There is no model in the retrieval path to have a bad day.",
  ["search", QUESTION, "--limit", "6"],
);

// ── 6. Cost ────────────────────────────────────────────────────────────────

run(
  "Count what it would have cost",
  "Characters that really would have crossed into a model's context, measured from this corpus. Quote the per-match pair, not the headline ratio: the ratio moves with how many documents matched, the per-match figure does not.",
  ["context-cost", QUESTION],
);

// ── 7. Governance ──────────────────────────────────────────────────────────

step(
  "Ask as someone else",
  "The counterparty credit lines are restricted to Risk Ops. Watch what a contractor gets: not a refusal, not a redaction — six useful results, with that page simply absent. There is nothing in the response to notice.",
  [
    eil(["search", SENSITIVE, "--limit", "6"], {
      EIL_PRINCIPAL: "a.contractor",
      EIL_USER_GROUPS: ENG,
    }),
  ],
);

step(
  "Now ask as Risk Ops",
  "Same query, same index, one group added. Visibility is stamped on the document, not decided by the query — so an unstamped document is owner-only and a bug in the application can only ever show you less.",
  [
    eil(["search", SENSITIVE, "--limit", "6"], {
      EIL_PRINCIPAL: "r.duval",
      EIL_USER_GROUPS: `${ENG},${RISK}`,
    }),
  ],
);

run(
  "Try to retrieve a credential",
  "One page in this corpus contains an AWS key and a database password. It was never chunked, so the credential is absent from the full-text index, the embeddings and every snippet. There is nothing to redact on the way out, because it never went in.",
  ["quarantine", "list"],
);

run(
  "Search for it anyway",
  "The page does not come back and the key appears nowhere in the response. Then say the harder half out loud: on a real codebase this also flags test fixtures and documentation that legitimately contain key-shaped strings, and `quarantine clear` accepts those — keyed on the value, so a different credential in the same file is caught again.",
  ["search", "AKIA aws access key deployment credentials", "--limit", "4"],
);

// ── 8. Observability ───────────────────────────────────────────────────────

run(
  "Everything you just watched, as rows",
  "Metrics are SQL views over the facts — the vw_* views ARE the definitions, not a dashboard's reading of them. Then look at the model-spend table, and note that it is empty. That is not missing instrumentation.",
  ["report", "--out", "demo/eil-metrics.html"],
);

run("Check the catalog's own integrity", "Read-only. `\"ok\": true` is an assertion, not a summary.", [
  "audit",
]);

console.log(`
\x1b[1mDone.\x1b[0m

  Metrics report:  demo/eil-metrics.html
  Everything lived in ${DATA}/ — nothing was installed and nothing outside this
  repo was touched.

  To hand the whole thing to an agent:
      claude mcp add eil -- pnpm -s --dir "$PWD" eil serve

  Reset:
      rm -rf ${DATA} .eil-repos demo/eil-metrics.html
`);
