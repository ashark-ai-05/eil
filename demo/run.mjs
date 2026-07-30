#!/usr/bin/env node
/**
 * The whole demo, on YOUR data, with nothing installed.
 *
 *   node demo/run.mjs --repo /path/to/your/repo --space ENG --project PAY
 *
 * No Docker, no Postgres: the backend is PGlite, which is real Postgres compiled
 * to WASM and loaded out of node_modules. The embedding model is vendored in the
 * repo, so the vector arm needs no network either.
 *
 * Scoped by construction. `--space` and `--project` are REQUIRED for the live
 * sources, because an unscoped Confluence sync pulls the entire instance — which
 * is a bad first experience and a bad thing to do to your org's API on a laptop.
 *
 * Every step prints the command it is about to run, so the demo is legible: the
 * audience sees the CLI, not a wrapper.
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
eil demo — real data, zero install

  node demo/run.mjs [options]

  --repo <path>      a local git repository to index
  --branch <name>    branch to index (default: the repo's current HEAD)
  --space <KEYS>     Confluence space key(s), comma-separated   [required for Confluence]
  --project <KEYS>   Jira project key(s), comma-separated       [required for Jira]
  --data <dir>       PGlite directory (default: .eil-demo)
  --keep             do not wipe --data first
  --skip-secrets     do not ingest the planted secret page
  --skip-corpus      do not ingest the PTR-DEMO fixture corpus (skips the gate beats)

Credentials, if you want the live sources:
  export EIL_CONFLUENCE_URL=https://confluence.your.org
  export EIL_JIRA_URL=https://jira.your.org
  eil auth login confluence     # stored in the OS keychain, never on disk
  eil auth login jira
`);
  process.exit(0);
}

const DATA = flag("data", ".eil-demo");
const REPO = flag("repo");
const SPACE = flag("space");
const PROJECT = flag("project");

const env = { ...process.env, EIL_DATABASE_URL: `pglite://${DATA}` };
let stepNo = 0;

/**
 * One banner, then one or more commands under it. The audience sees the command
 * it is about to run before it runs, every time — a step whose output arrives
 * with no visible cause is a step nobody believes.
 */
function step(title, why, cmds, { optional = false } = {}) {
  stepNo += 1;
  console.log(`\n\x1b[1m── ${stepNo}. ${title}\x1b[0m`);
  console.log(`   ${why}`);
  let ok = true;
  for (const { show, bin, argv } of cmds) {
    console.log(`   \x1b[2m$ ${show}\x1b[0m\n`);
    const r = spawnSync(bin[0], [...bin.slice(1), ...argv], { stdio: "inherit", env });
    if (r.status === 0) continue;
    ok = false;
    if (!optional) {
      console.error(`\nStep failed. Fix it and re-run, or pass --keep to resume from here.`);
      process.exit(r.status ?? 1);
    }
  }
  return ok;
}

const run = (title, why, argv, opts) =>
  step(title, why, [{ show: `eil ${argv.join(" ")}`, bin: ["pnpm", "-s", "eil"], argv }], opts);

/** Several commands under one banner — thirteen fixtures do not want thirteen headings. */
const runEach = (title, why, argvs, opts) =>
  step(
    title,
    why,
    argvs.map((argv) => ({ show: `eil ${argv.join(" ")}`, bin: ["pnpm", "-s", "eil"], argv })),
    opts,
  );

/** The tamper drill is a node script, not an `eil` verb, and is shown as one. */
const runNode = (title, why, script, argv = [], opts) =>
  step(
    title,
    why,
    [{ show: `node ${script} ${argv.join(" ")}`.trim(), bin: ["node", script], argv }],
    opts,
  );

// A stale clone cache makes `git clone` fail with a raw git error and no
// recovery — hit while rehearsing, so it is handled rather than documented.
if (existsSync(".eil-repos")) rmSync(".eil-repos", { recursive: true, force: true });
if (!has("keep") && existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });

console.log(`\x1b[1mEIL demo\x1b[0m — backend: PGlite at ${DATA} (no server, no admin rights)`);

run(
  "Preflight",
  "Prove the credentials, the model and the repo all work BEFORE the audience is watching.",
  ["demo:preflight", ...(REPO ? ["--repo", REPO] : [])],
  { optional: true },
);

run("Create the catalog", "19 migrations into an embedded Postgres. Nothing was installed.", [
  "db",
  "migrate",
]);

if (SPACE) {
  run(
    "Ingest Confluence",
    `Space ${SPACE}, using YOUR personal token — you can only index what you could already read.`,
    ["ingest", "confluence", "--space", SPACE],
  );
} else {
  console.log("\n   (skipping Confluence: pass --space ENG to include it)");
}

if (PROJECT) {
  run("Ingest Jira", `Project ${PROJECT}. Issue links and labels become graph edges.`, [
    "ingest",
    "jira",
    "--project",
    PROJECT,
  ]);
} else {
  console.log("\n   (skipping Jira: pass --project PAY to include it)");
}

if (REPO) {
  // The default --branch is `main`; plenty of repos are `master`, and the clone
  // then fails with a raw git error. Ask the repo instead of assuming.
  const head = spawnSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf-8",
  });
  const branch = flag("branch", head.stdout?.trim() || "main");
  const name = REPO.replace(/\/+$/, "").split(/[/\\]/).pop() || "repo";
  run(
    "Ingest the codebase",
    `Commit dates become recency, imports and ticket keys become edges. Branch '${branch}'.`,
    ["ingest", "repo", REPO, "--branch", branch, "--name", name, "--include", "**/*.*"],
  );
} else {
  console.log("\n   (skipping code: pass --repo /path/to/repo to include it)");
}

// The PTR-DEMO corpus the requirements artefact cites. This is NOT optional
// decoration: CLARIFY-005 re-reads every cited quote out of the catalog, so
// without these documents the gate refuses the CLEAN artefact — which on a
// projector looks exactly like the gate misfiring. Ingest before the gate beats.
const FIXTURES = "demo/fixtures";
if (!has("skip-corpus") && existsSync(FIXTURES)) {
  const files = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort();
  runEach(
    "Ingest the demo corpus",
    "Eight Confluence pages and five Jira tickets, deliberately contradictory. The requirements artefact cites them by id, and the gate re-reads every citation.",
    files.map((f) => [
      "ingest",
      f.startsWith("ptrd-") ? "confluence" : "jira",
      "--fixture",
      join(FIXTURES, f),
    ]),
  );
  run("Refresh corpus statistics", "BM25 needs document frequency, N and avgdl to mean anything.", [
    "stats:refresh",
  ]);
}

if (!has("skip-secrets")) {
  run(
    "Plant a page containing credentials",
    "A realistic runbook with an AWS key and a database password in it.",
    ["ingest", "confluence", "--fixture", "demo/secret-page.json"],
  );
}

// Both embedding steps are OPTIONAL, and the demo continues without them.
// `@huggingface/transformers` is an optional dependency: it has not materialised
// on this machine, and behind a corporate proxy it may never. The four lexical
// arms — strict and loose FTS over prose, strict and loose over the code index —
// are complete without it; what is lost is the vector arm, and saying so is
// a better demo than a stack trace. Never substitute EIL_EMBED_PROVIDER=fake:
// that produces random vectors, and calling the result semantic search is a lie.
const EMBED_FALLBACK = "   embeddings unavailable — running lexical arms only";

const embedded = run(
  "Embed",
  "Local ONNX model, vendored in the repo. No network, no per-query cost.",
  ["embed", "backfill"],
  { optional: true },
);

if (!embedded) console.log(`\n${EMBED_FALLBACK}`);
else if (
  !run(
    "Build the coarse vector index",
    "Watch it MEASURE its own recall curve and pick nprobe — the parameter is not a guess.",
    ["ivf", "build"],
    { optional: true },
  )
)
  console.log(`\n${EMBED_FALLBACK}`);

run(
  "Search",
  "Four lexical arms — strict and loose, prose and code — plus a vector arm when the local model is available, fused by rank. Note top_score / arms_contributing.",
  ["search", "how do we handle retries"],
  { optional: true },
);

if (REPO) {
  run("Search code", "Identifier and path routes hit the code index, not the prose arm.", [
    "search",
    "retryHandler",
  ], { optional: true });
}

if (!has("skip-secrets")) {
  run(
    "The credentials are NOT retrievable",
    "The page was quarantined at ingest: never chunked, so it is absent from tsv, embeddings and snippets.",
    ["search", "deploying the payment service"],
    { optional: true },
  );
}

// The gate. Skipped rather than failed when the artefact is absent, because a
// fresh clone has not run the elaboration yet and a missing file is not a
// refusal — the two must never look alike. But skipping is not a detail: these
// are the two beats the whole demo builds to, and a one-line parenthetical
// scrolls past. So the skip is a banner that names the file, the command that
// creates it, and what did not happen.
const REQS = "demo/PTR-401.reqs.json";
const gateRan = existsSync(REQS);
if (gateRan) {
  run(
    "Run the gate over a requirements artefact",
    "46 checks. Every generated field recomputed, every cited quote re-read out of the corpus.",
    ["reqs", "check", REQS],
  );

  runNode(
    "Tamper with it",
    "Six single-field edits to a signed artefact. Six refusals, each naming the check that caught it.",
    "demo/tamper.mjs",
  );
} else {
  const warn = (s) => console.log(`\x1b[1;31m${s}\x1b[0m`);
  const rule = "━".repeat(78);
  console.log("");
  warn(rule);
  warn("  !!  THE TWO MOST IMPORTANT BEATS OF THIS DEMO DID NOT RUN  !!");
  warn("");
  warn(`  Missing file:   ${REQS}`);
  warn(`  Create it with: pnpm eil reqs elaborate PTR-401 --out ${REQS}`);
  warn("");
  warn("  NOT RUN  the gate          eil reqs check — 46 checks over a signed artefact");
  warn("  NOT RUN  the tamper drill  node demo/tamper.mjs — six edits, six refusals");
  warn("");
  warn("  The tamper drill IS the beat; everything above it is setup. Generate the");
  warn("  artefact and re-run before presenting — as it stands the demo stops short");
  warn("  of its own point.");
  warn(rule);
  console.log("");
}

run("Audit", "Integrity invariants, plus the quarantine worklist. ok:true is the assertion.", [
  "audit",
]);

run(
  "Mine an eval set from real traffic",
  "Every search above was audited; these become the labelled set. This is why the golden file never grew by hand.",
  ["eval:mine"],
  { optional: true },
);

run("Build a judging worksheet", "Pooled, graded 0-3, incrementally reusable.", [
  "eval:judge",
  "--export",
  "demo/judgments.md",
], { optional: true });

run("Metrics report", "Self-contained HTML over the fact tables — no Grafana, no Docker.", [
  "report",
  "--out",
  "demo/metrics.html",
], { optional: true });

if (!gateRan) {
  console.log(
    `\n\x1b[1;31mIncomplete: the gate and the tamper drill were skipped — ${REQS} does not exist.\x1b[0m`,
  );
}

console.log(`
\x1b[1mDone.\x1b[0m

  demo/metrics.html      the report, open it in a browser
  demo/judgments.md      grade a few, then:  eil eval:judge --import demo/judgments.md
                                              eil eval:run --persist

  Point an agent at it:
    claude mcp add eil -- pnpm -s --dir ${process.cwd()} eil serve

  Everything lives in ${DATA}/ — delete it and the demo is gone.
`);
