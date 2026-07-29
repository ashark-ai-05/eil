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
import { existsSync, rmSync } from "node:fs";

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

function run(title, why, argv, { optional = false } = {}) {
  stepNo += 1;
  console.log(`\n\x1b[1m── ${stepNo}. ${title}\x1b[0m`);
  console.log(`   ${why}`);
  console.log(`   \x1b[2m$ eil ${argv.join(" ")}\x1b[0m\n`);
  const r = spawnSync("pnpm", ["-s", "eil", ...argv], { stdio: "inherit", env });
  if (r.status !== 0 && !optional) {
    console.error(`\nStep failed. Fix it and re-run, or pass --keep to resume from here.`);
    process.exit(r.status ?? 1);
  }
  return r.status === 0;
}

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

run("Create the catalog", "18 migrations into an embedded Postgres. Nothing was installed.", [
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

if (!has("skip-secrets")) {
  run(
    "Plant a page containing credentials",
    "A realistic runbook with an AWS key and a database password in it.",
    ["ingest", "confluence", "--fixture", "demo/secret-page.json"],
  );
}

run("Embed", "Local ONNX model, vendored in the repo. No network, no per-query cost.", [
  "embed",
  "backfill",
]);

run(
  "Build the coarse vector index",
  "Watch it MEASURE its own recall curve and pick nprobe — the parameter is not a guess.",
  ["ivf", "build"],
);

run(
  "Search",
  "Two lexical arms and a vector arm, fused by rank. Note top_score / arms_contributing.",
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

console.log(`
\x1b[1mDone.\x1b[0m

  demo/metrics.html      the report, open it in a browser
  demo/judgments.md      grade a few, then:  eil eval:judge --import demo/judgments.md
                                              eil eval:run --persist

  Point an agent at it:
    claude mcp add eil -- pnpm -s --dir ${process.cwd()} eil serve

  Everything lives in ${DATA}/ — delete it and the demo is gone.
`);
