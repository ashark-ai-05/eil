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
  --no-colour      plain output, no ANSI (also honours NO_COLOR)
  --colour         force ANSI even when piped (also honours FORCE_COLOR)

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

/**
 * Colour is off when stdout is not a terminal, when NO_COLOR is set, or on
 * --no-colour: a demo that sprays escape codes into a pipe or a CI log is one
 * somebody screenshots looking broken.
 *
 * FORCE_COLOR / --colour override that, for the legitimate cases where stdout
 * is not a tty but the consumer still renders ANSI — `| less -R`, `tee` to a
 * file you will `cat` later, most CI log viewers.
 */
const FORCED = has("colour") || has("color") || !!process.env.FORCE_COLOR;
const COLOUR =
  FORCED ||
  (process.stdout.isTTY && !process.env.NO_COLOR && !has("no-colour") && !has("no-color"));
const sgr = (code) => (s) => (COLOUR ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: sgr(1),
  dim: sgr(2),
  cyan: sgr(36),
  amber: sgr(33),
  green: sgr(32),
  red: sgr(31),
  grey: sgr(90),
};

/** Reverse-video chip, so the step number reads as a marker and not as text. */
const badge = (s) => (COLOUR ? `\x1b[46m\x1b[30m\x1b[1m${s}\x1b[0m` : `[${s.trim()}]`);
const RULE = "─".repeat(74);

function pause() {
  if (!has("pause")) return;
  spawnSync("bash", ["-c", 'read -r -p "  ↵ " _ < /dev/tty'], { stdio: "inherit" });
}

/**
 * One heading, one or more commands beneath it.
 *
 * `say` is the line to deliver while it runs. `watch` is the more useful one:
 * it names the thing in the output that the step exists to show, in amber,
 * BEFORE the output scrolls past. Without it a room watches a wall of JSON go
 * by and takes nothing from it — the presenter knows what mattered and nobody
 * else does.
 */
function step(title, say, cmds, { optional = false, extraEnv = {}, watch = null } = {}) {
  stepNo += 1;
  console.log(`\n${c.grey(RULE)}`);
  console.log(`${badge(` ${String(stepNo).padStart(2)} `)} ${c.bold(title)}`);
  console.log(`    ${c.dim(say)}`);
  if (watch) console.log(`    ${c.amber("▸ look for:")} ${c.amber(watch)}`);
  let ok = true;
  for (const { show, bin, argv, env: cmdEnv } of cmds) {
    console.log(`\n    ${c.green("$")} ${c.green(show)}\n`);
    const r = spawnSync(bin[0], [...bin.slice(1), ...argv], {
      stdio: "inherit",
      env: { ...env, ...extraEnv, ...(cmdEnv ?? {}) },
    });
    if (r.status === 0) continue;
    ok = false;
    if (!optional) {
      console.error(`\n${c.red("Step failed.")} Fix it and re-run, or pass --keep to resume here.`);
      process.exit(r.status ?? 1);
    }
    console.log(`    ${c.amber("(optional step skipped — the run continues)")}`);
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

console.log(`\n${c.cyan(c.bold("EIL — the knowledge plane"))}`);
console.log(c.dim(`backend  PGlite at ${DATA} · no server, no Docker, no admin rights`));
console.log(c.dim("corpus   demo/fixtures/ + demo/repo/ · nothing here touches the network"));
console.log(
  `\n${c.amber("▸ look for")} lines mark what each step is actually demonstrating.` +
    `\n  ${c.dim("--pause steps through it · --no-colour for a plain log")}`,
);

// ── 2. Ingestion ───────────────────────────────────────────────────────────
// Deliberately BEFORE the opening question, because there has to be an index
// to ask. The narration opens on step 3; steps 1 and 2 are the stage being set,
// and a presenter who wants the room watching from the first command should
// run this much beforehand and start the talk at step 3.

run(
  "Create the catalog",
  "Nineteen migrations into a Postgres running inside this Node process. The same schema runs unchanged against a real cluster.",
  ["db", "migrate"],
  { watch: "applied: [...19 files] — nineteen migrations, no server was installed" });

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
  { watch: "\"1 seen, 1 changed\" on each — thirteen documents entering the index" });

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
  { watch: "\"10 upserted\" and the commit SHA it stopped at" });

run("Compute the statistics", "Document frequency, N and average length — the ranking groundwork.", [
  "stats:refresh",
],
  { watch: "the ranking groundwork — nothing to see, it just has to have happened" });

if (!has("skip-embed")) {
  run(
    "Embed, locally",
    "A vendored ONNX model, on this laptop. Nothing is sent anywhere and no per-query cost is incurred. If the model is missing this step is skipped and search runs lexical-only.",
    ["embed", "backfill"],
    { optional: true, watch: "\"embedded 49/49\" and the provider name — local, so nothing left this laptop" },
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
  { watch: "\"0 changed\" and \"up to date (<sha>)\" — THIS is the step. Nothing was re-read." });

// ── 4. What is in there, and what scores it ────────────────────────────────

run(
  "Look at the index",
  "Unit-normalized float4[], so cosine is a plain dot product Postgres computes itself. The extension list is read out of pg_extension and it is empty. There is no vector database here.",
  ["index:stats"],
  { watch: "\"extensions: none installed\" and \"unit-normalized\" — no vector database anywhere" });

// ── 5. The opening question — one system at a time, then all of them ───────

run(
  "Ask it of Confluence alone",
  "This is the shape of asking today. You get the rule — a control that cannot be evaluated has not passed — and nothing else. It is correct, and it is not an answer.",
  ["search", QUESTION, "--source", "confluence", "--limit", "3"],
  { watch: "one page: the rule. No number, no ticket, no code. Correct, and not an answer." });

run(
  "Ask it of Jira alone",
  "The ticket where the threshold was agreed. Again true, again partial.",
  ["search", QUESTION, "--source", "jira", "--limit", "3"],
  { watch: "PTR-415 — the number somebody agreed. Also true, also partial." });

run(
  "Now ask all of it",
  "Four lexical arms — strict and loose, over prose and over code — plus a vector arm, fused by reciprocal rank. The rule, the agreed number, and the line that enforces it. Point at `executor`: those are the arms that actually contributed. No model ran.",
  ["search", QUESTION, "--limit", "6"],
  { watch: "\"executor\" — the arms that ran; and three sources in the top four" });

run(
  "Ask it again",
  "Same query, same corpus, same order. Every time. There is no model in the retrieval path to have a bad day.",
  ["search", QUESTION, "--limit", "6"],
  { watch: "the same ids in the same order. Byte for byte." });

// ── 6. Cost ────────────────────────────────────────────────────────────────

run(
  "Count what it would have cost",
  "Characters that really would have crossed into a model's context, measured from this corpus. Quote the per-match pair, not the headline ratio: the ratio moves with how many documents matched, the per-match figure does not.",
  ["context-cost", QUESTION],
  { watch: "\"Per match:\" — quote THAT pair, not the headline ratio" });

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
  { watch: "six useful results, and ptrd-7 is not among them. No error. Nothing to notice." });

step(
  "Now ask as Risk Ops",
  "Same query, same index, one group added. Visibility is stamped on the document, not decided by the query — so an unstamped document is owner-only and a bug in the application can only ever show you less.",
  [
    eil(["search", SENSITIVE, "--limit", "6"], {
      EIL_PRINCIPAL: "r.duval",
      EIL_USER_GROUPS: `${ENG},${RISK}`,
    }),
  ],
  { watch: "ptrd-7 at the top, with a 250m credit line in the snippet" });

run(
  "Try to retrieve a credential",
  "One page in this corpus contains an AWS key and a database password. It was never chunked, so the credential is absent from the full-text index, the embeddings and every snippet. There is nothing to redact on the way out, because it never went in.",
  ["quarantine", "list"],
  { watch: "one quarantined page — it was never chunked" });

run(
  "Search for it anyway",
  "The page does not come back and the key appears nowhere in the response. Then say the harder half out loud: on a real codebase this also flags test fixtures and documentation that legitimately contain key-shaped strings, and `quarantine clear` accepts those — keyed on the value, so a different credential in the same file is caught again.",
  ["search", "AKIA aws access key deployment credentials", "--limit", "4"],
  { watch: "the page is absent and AKIA appears nowhere in the response" });

// ── 8. Observability ───────────────────────────────────────────────────────

run(
  "Everything you just watched, as rows",
  "Metrics are SQL views over the facts — the vw_* views ARE the definitions, not a dashboard's reading of them. Then look at the model-spend table, and note that it is empty. That is not missing instrumentation.",
  ["report", "--out", "demo/eil-metrics.html"],
  { watch: "the report is written — open it and look at vw_zero_results" });

run("Check the catalog's own integrity", "Read-only. `\"ok\": true` is an assertion, not a summary.", [
  "audit",
],
  { watch: "\"ok\": true — an assertion, not a summary" });

console.log(`\n${c.grey(RULE)}`);
console.log(`${COLOUR ? "\x1b[42m\x1b[30m\x1b[1m ✓ \x1b[0m" : "[done]"} ${c.bold("Done.")} ${stepNo} steps.\n`);
console.log(`    ${c.bold("The three to remember")}`);
console.log(`      ${c.amber("1.")} One question, three sources — no single pipe answered it.`);
console.log(`      ${c.amber("2.")} The contractor got six results and could not tell one was withheld.`);
console.log(`      ${c.amber("3.")} ${c.bold("The model-spend table is empty.")} That is the architecture, not a gap.\n`);
console.log(`    ${c.bold("Keep exploring — this catalog is not in your shell yet:")}`);
console.log(`      ${c.green(`export EIL_DATABASE_URL=pglite://${DATA}`)}\n`);
console.log(`    ${c.dim("report")}   demo/eil-metrics.html`);
console.log(`    ${c.dim("to agent")} claude mcp add eil -- pnpm -s --dir "$PWD" eil serve`);
console.log(`    ${c.dim("reset")}    rm -rf ${DATA} .eil-repos demo/eil-metrics.html\n`);
