#!/usr/bin/env node
/**
 * Six tampers, six named refusals.
 *
 *   node demo/tamper.mjs                    # all six
 *   node demo/tamper.mjs --tamper 4         # just one
 *   node demo/tamper.mjs path/to/other.reqs.json
 *
 * Each tamper copies the source artefact to a temp file, applies EXACTLY ONE
 * mutation, runs the real `eil reqs check` over it, and asserts the refusal
 * names the check we said it would. Nothing is simulated: the CLI the audience
 * watched a moment ago is the CLI that runs here.
 *
 * Two things this script is careful about, because both have bitten a rehearsal:
 *
 *  1. CLARIFY-005 — the only check that leaves the artefact and re-reads the
 *     cited document — is SKIPPED, not failed, when no catalog is reachable. The
 *     sole trace is `checksRun` being 44 instead of 45, which nobody notices on
 *     a projector. Tamper 4 would then look like a pass while never having run.
 *     So every run asserts `checksRun === 45` and stops loudly if it is not.
 *
 *  2. An unresolvable `docId` is an ERROR by design, so ANY drift between the
 *     ingested corpus and the artefact's citations refuses the CLEAN artefact.
 *     That is the likeliest accidental failure on stage, and it is confusing
 *     precisely because it looks like the gate misfiring. So the baseline runs
 *     FIRST, and a broken baseline stops everything before a single tamper.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXPECTED_CHECKS = 45;
const DEFAULT_SOURCE = "demo/PTR-401.reqs.json";

const args = process.argv.slice(2);
/** the only flags that consume the following argument */
const VALUE_FLAGS = new Set(["tamper", "data"]);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a.startsWith("--")) {
    if (VALUE_FLAGS.has(a.slice(2))) i += 1;
    continue;
  }
  positional.push(a);
}

if (has("help")) {
  console.log(`
eil tamper drill — modify a signed artefact, watch the gate name the breach

  node demo/tamper.mjs [artefact] [options]

  artefact           a reqs.json to tamper with (default: ${DEFAULT_SOURCE})
  --tamper <n>       run only tamper n (1-6); default is all six
  --data <dir>       PGlite directory (default: .eil-demo), used only when
                     EIL_DATABASE_URL is not already set
  --keep             leave the tampered copies on disk and print where

The catalog must be up: CLARIFY-005 re-reads every cited quote out of it, and
without it the check does not fail — it disappears. This script refuses to run
a drill in which that could happen silently.
`);
  process.exit(0);
}

const DATA = flag("data", ".eil-demo");
const DB = process.env.EIL_DATABASE_URL ?? `pglite://${DATA}`;
const env = { ...process.env, EIL_DATABASE_URL: DB };

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const RED = (s) => `\x1b[1;31m${s}\x1b[0m`;
/** the check id, in reverse video — this is the thing to read from the back of the room */
const BADGE = (s) => `\x1b[1;7m ${s} \x1b[0m`;

const LABEL = 11;
const field = (name, value) => console.log(`   ${name.padEnd(LABEL)}${value}`);

function die(lines) {
  console.log("");
  for (const l of [].concat(lines)) console.log(`  ${l === "" ? "" : RED(l)}`);
  console.log("");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// running the real gate

/**
 * `eil reqs check --json` over one file. `--json` is what makes `checksRun`
 * legible; the pretty printer does not surface it as a number we can assert on.
 */
function runCheck(file) {
  const r = spawnSync("pnpm", ["-s", "eil", "reqs", "check", file, "--json"], {
    encoding: "utf-8",
    env,
  });
  const out = r.stdout ?? "";
  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  if (first < 0 || last < first) {
    die([
      "`eil reqs check --json` produced no JSON. The gate could not be run at all.",
      "",
      ...`${out}\n${r.stderr ?? ""}`.trim().split("\n").slice(0, 20),
    ]);
  }
  let result;
  try {
    result = JSON.parse(out.slice(first, last + 1));
  } catch (err) {
    die([`could not parse the analyser result: ${err.message}`, "", ...out.split("\n").slice(0, 20)]);
  }
  const errors = (result.findings ?? []).filter((f) => f.severity === "error");
  return {
    ok: result.ok === true,
    checksRun: result.checksRun ?? 0,
    findings: result.findings ?? [],
    errorIds: [...new Set(errors.map((f) => f.id))],
    stderr: (r.stderr ?? "").trim(),
  };
}

/**
 * The silent-skip guard. 44 is not "one check short" — it is specifically the
 * one check that leaves the artefact, and its absence turns tamper 4 into
 * theatre. Name the cause, because "44" on its own tells a presenter nothing.
 */
function assertChecksRun(result, where) {
  if (result.checksRun === EXPECTED_CHECKS) return;
  if (result.checksRun === EXPECTED_CHECKS - 1) {
    die([
      `Only 44 of ${EXPECTED_CHECKS} checks ran (${where}).`,
      "",
      "CLARIFY-005 — the check that re-reads every cited quote out of the corpus —",
      "was SKIPPED because no document resolver was available. It does not fail when",
      "the catalog is missing; it disappears. Tamper 4 would then print a pass while",
      "never having verified a single citation, so the drill stops here instead.",
      "",
      `The catalog it tried to open: ${DB}`,
      "",
      "In order of likelihood:",
      "  - EIL_DATABASE_URL is unset or points somewhere else",
      "  - the catalog exists but was never migrated:   pnpm eil db migrate",
      "  - the catalog is migrated but has no documents: pnpm corpus:build, then",
      "    pnpm eil ingest confluence --fixture demo/fixtures/ptrd-1.json (and the rest)",
      ...(result.stderr ? ["", `The CLI said: ${result.stderr.split("\n")[0]}`] : []),
    ]);
  }
  die([
    `${result.checksRun} checks ran, expected ${EXPECTED_CHECKS} (${where}).`,
    "The analyser's check registry has changed since this drill was written.",
    "Reconcile demo/tamper.mjs with ts/reqs/analyse.ts before presenting.",
  ]);
}

/** The findings table, in the CLI's own column order, for the baseline failure. */
function printFindings(findings) {
  const idW = Math.max(11, ...findings.map((f) => f.id.length + 2));
  const pathW = Math.min(40, Math.max(14, ...findings.map((f) => f.path.length + 2)));
  console.log(`  ${"CHECK".padEnd(idW)}${"SEVERITY".padEnd(10)}${"PATH".padEnd(pathW)}WHAT IS WRONG`);
  for (const f of findings) {
    const sev = f.severity === "error" ? "ERROR" : "warn";
    const msg = f.message.length > 90 ? `${f.message.slice(0, 89)}…` : f.message;
    console.log(`  ${f.id.padEnd(idW)}${sev.padEnd(10)}${f.path.padEnd(pathW)}${msg}`);
  }
}

// ---------------------------------------------------------------------------
// the source artefact

/**
 * The demo artefact is generated by the elaboration run. If it is not there —
 * a fresh clone, or a rehearsal before that step — fall back to the same
 * minimal body the unit tests use, run through the assembler so every generated
 * field is correct. Said on stderr, because a drill against a different artefact
 * than the audience just watched is worth knowing about.
 */
function generateFallback(dir) {
  const out = join(dir, "fallback.reqs.json");
  const gen = join(dir, "generate.mts");
  const root = resolve(process.cwd());
  writeFileSync(
    gen,
    [
      `import { assemble } from ${JSON.stringify(join(root, "ts/reqs/assemble.js"))};`,
      `import { minimalBody } from ${JSON.stringify(join(root, "ts/tests/helpers/reqs-fixture.js"))};`,
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(assemble(minimalBody()), null, 2) + "\\n");`,
    ].join("\n"),
  );
  const r = spawnSync("pnpm", ["-s", "exec", "tsx", gen], { encoding: "utf-8", env });
  if (r.status !== 0 || !existsSync(out)) {
    die([
      `${DEFAULT_SOURCE} does not exist and the fallback artefact could not be generated.`,
      "",
      ...`${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(0, 15),
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the six tampers
//
// Each `apply` mutates a deep clone in place and returns either a description of
// what it did, or `{ skip }` when the source artefact has nothing of that kind
// to tamper with. A skip is never a pass: it is counted and reported separately,
// because "we did not test that" and "that held" are different claims.

/** Depth-first, parents before children — the same order the analyser walks. */
function* walk(node) {
  yield { node };
  for (const c of node.children ?? []) yield* walk(c);
}

/** Every citation in the body, in the order `citations()` builds them. */
function citations(body) {
  const out = [];
  for (const { node } of walk(body.tree))
    (node.grounding ?? []).forEach((g, i) =>
      out.push({ g, where: `${node.id}.grounding.${i}`, owner: node.id }),
    );
  (body.clarifications ?? []).forEach((c, ci) =>
    (c.grounding ?? []).forEach((g, i) =>
      out.push({ g, where: `clarifications.${ci}.grounding.${i}`, owner: c.id }),
    ),
  );
  return out;
}

const TAMPERS = [
  {
    n: 1,
    title: "A stored score was edited",
    expect: ["SCORE-001"],
    apply(body) {
      const node = body.tree;
      const from = node.score.magnitude;
      node.score.magnitude = 21;
      return {
        plain: `changed a stored score from ${from} to 21 — the biggest band there is`,
        why:
          "magnitude is generated, not authored: the scorer derives it from unknowns and " +
          "complexity. The file now disagrees with its own arithmetic.",
        where: `${node.id}.score.magnitude`,
      };
    },
  },
  {
    n: 2,
    title: "A decision was deferred in prose",
    expect: ["DEFER-001"],
    apply(body) {
      body.tree.statement += " Effective timing TBD.";
      return {
        plain: 'appended " Effective timing TBD." to the top-level requirement',
        why:
          "a requirement that says TBD has not been elaborated, it has been postponed. " +
          "The gate does not accept postponement dressed as a statement.",
        where: `${body.tree.id}.statement`,
      };
    },
  },
  {
    n: 3,
    title: "A recorded question was deleted",
    expect: ["CLARIFY-001"],
    apply(body) {
      const list = body.clarifications ?? [];
      if (list.length === 0) return { skip: "source artefact has no clarification to tamper" };
      // Only a clarification whose node still records a `clarify` pass leaves the
      // contradiction CLARIFY-001 exists to catch. Deleting any other one is a
      // legal edit, and asserting a refusal on it would be asserting a bug.
      const asks = new Set();
      for (const { node } of walk(body.tree))
        if ((node.scoreHistory ?? []).some((p) => p.decision === "clarify")) asks.add(node.id);
      const i = list.findIndex((c) => asks.has(c.nodeId));
      if (i < 0)
        return {
          skip: "no clarification in the source artefact answers a node that recorded a clarify pass",
        };
      const [removed] = list.splice(i, 1);
      return {
        plain: `deleted the question ${removed.id} while leaving the record that it was asked`,
        why:
          `node ${removed.nodeId} still records a clarify pass, so the artefact claims a ` +
          "question was put to a human that it no longer contains.",
        where: `clarifications.${i}`,
      };
    },
  },
  {
    n: 4,
    title: "A quoted citation was reworded",
    expect: ["CLARIFY-005"],
    apply(body) {
      const cited = citations(body);
      if (cited.length === 0) return { skip: "source artefact has no grounding to tamper" };
      const { g, where } = cited[0];
      const words = g.quote.split(/(\s+)/);
      const i = words.findIndex((w) => /^[A-Za-z][A-Za-z-]{3,}$/.test(w));
      if (i < 0) return { skip: "the first quoted citation has no word long enough to reword" };
      const from = words[i];
      words[i] = "elephant";
      g.quote = words.join("");
      return {
        plain: `changed one word inside a quote — "${from}" became "elephant"`,
        why:
          `the gate re-reads ${g.docId} out of the corpus and looks for that quote ` +
          "character for character. A citation nobody can find is a citation nobody made.",
        where: `${where}.quote`,
      };
    },
  },
  {
    n: 5,
    title: "An agent signed off",
    expect: ["GATE-006"],
    apply(body) {
      const approvers = body.signoff?.approvers ?? [];
      if (approvers.length === 0) return { skip: "source artefact carries no sign-off to tamper" };
      const from = approvers[0].kind;
      approvers[0].kind = "agent";
      return {
        plain: `changed the first approver from "${from}" to "agent"`,
        why:
          `${approvers[0].name} is recorded as ${JSON.stringify(approvers[0].role)}. An agent may ` +
          "draft, score and ground a requirement set. It may never approve one.",
        where: "signoff.approvers.0.kind",
      };
    },
  },
  {
    n: 6,
    title: "The traceability index was emptied",
    expect: ["META-002", "TRACE-001"],
    apply(body) {
      const had = Object.keys(body.traceability ?? {}).length;
      if (had === 0) return { skip: "source artefact has an empty traceability index already" };
      body.traceability = {};
      return {
        plain: `deleted all ${had} entries linking acceptance criteria back to requirements`,
        why:
          "the index is generated by inverting the tree, so it cannot be edited without the " +
          "two disagreeing — and every acceptance criterion is now untraceable.",
        where: "traceability",
      };
    },
  },
];

// ---------------------------------------------------------------------------

const only = flag("tamper");
if (only !== null && !TAMPERS.some((t) => String(t.n) === only)) {
  die([`--tamper must be one of 1-${TAMPERS.length} (got '${only}')`]);
}
const selected = only === null ? TAMPERS : TAMPERS.filter((t) => String(t.n) === only);

const dir = mkdtempSync(join(tmpdir(), "eil-tamper-"));

let source = positional[0] ?? DEFAULT_SOURCE;
let fellBack = false;
if (!existsSync(source)) {
  if (positional[0]) die([`no such file: ${source}`]);
  console.error(
    `${DEFAULT_SOURCE} is not there — falling back to the minimal test artefact.\n` +
      "Tampers needing a clarification, a citation or a sign-off will be SKIPPED, not passed.",
  );
  source = generateFallback(dir);
  fellBack = true;
}

console.log(`
${B("EIL tamper drill")} — modify a signed artefact, watch the gate name the breach
   ${"artefact".padEnd(LABEL)}${source}${fellBack ? DIM("   (fallback — see stderr)") : ""}
   ${"catalog".padEnd(LABEL)}${DB}
   ${"tampers".padEnd(LABEL)}${selected.map((t) => t.n).join(", ")} of ${TAMPERS.length}`);

// --- the baseline, before anything is touched ------------------------------

console.log(`\n${B("── Baseline")}`);
console.log("   The untouched artefact has to PASS, or no refusal below means anything.");
console.log(`   ${DIM(`$ eil reqs check ${source}`)}\n`);

const base = runCheck(source);
assertChecksRun(base, "on the clean artefact");
if (!base.ok) {
  printFindings(base.findings);
  die([
    "THE CLEAN BASELINE IS BROKEN. No tampers were run.",
    "",
    "The artefact is refused before anything has been tampered with, so every refusal",
    "below would have proved nothing. Fix the artefact, not the drill.",
    `  ${source}`,
    "",
    ...(base.errorIds.includes("CLARIFY-005")
      ? [
          "CLARIFY-005 on a clean artefact almost always means the artefact's citations and",
          "the ingested corpus have drifted apart: a cited docId is not in this catalog, or",
          "the quoted text no longer matches the document. An unresolvable citation is an",
          "error by design — the gate will not verify what it cannot read. Re-ingest the",
          "corpus, or regenerate the artefact against the corpus you actually have.",
        ]
      : [`Refused by: ${base.errorIds.join(", ")}`]),
  ]);
}
field("result", `${base.checksRun} checks run, 0 errors — ${B("PASSED")}`);

// --- the tampers ------------------------------------------------------------

const results = [];
for (const t of selected) {
  // Re-read per tamper rather than deep-cloning one parse: each mutation is
  // applied to a pristine copy, so nothing can leak from one tamper to the next.
  const body = JSON.parse(await readFile(source, "utf-8"));
  const applied = t.apply(body);

  console.log(`\n${B(`── ${t.n}. ${t.title}`)}`);
  if (applied.skip) {
    console.log(`   ${RED(`SKIPPED — ${applied.skip}`)}`);
    field("expected", t.expect.join(", "));
    field("observed", DIM("nothing — this tamper was not applied, so it did not run"));
    results.push({ t, state: "skipped", note: applied.skip });
    continue;
  }

  const file = join(dir, `tamper-${t.n}.reqs.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);

  console.log(`   ${applied.why}`);
  console.log(`   ${DIM(`$ eil reqs check ${file}`)}\n`);
  const r = runCheck(file);
  assertChecksRun(r, `on tamper ${t.n}`);

  // "includes", never "equals": one mutation legitimately trips more than one
  // check — an edited score is both wrong arithmetic (SCORE-001) and an authored
  // generated field (META-002) — and demanding an exact set would make the drill
  // fail for being MORE right than expected.
  const missing = t.expect.filter((id) => !r.errorIds.includes(id));
  const extra = r.errorIds.filter((id) => !t.expect.includes(id));
  const caught = missing.length === 0 && !r.ok;

  field("changed", applied.plain);
  field("at", applied.where);
  field("expected", t.expect.map((id) => B(id)).join("  "));
  field("observed", r.errorIds.length === 0 ? RED("nothing — the artefact PASSED") : r.errorIds.join(", "));
  if (caught) {
    console.log(
      `   ${"verdict".padEnd(LABEL)}REFUSED by ${t.expect.map(BADGE).join(" ")}` +
        `${extra.length > 0 ? DIM(`  (also ${extra.join(", ")})`) : ""}`,
    );
  } else {
    console.log(`   ${"verdict".padEnd(LABEL)}${RED(`NOT CAUGHT — expected ${missing.join(", ")}`)}`);
  }
  results.push({ t, state: caught ? "caught" : "missed", missing, observed: r.errorIds });
}

// --- summary ----------------------------------------------------------------

const caught = results.filter((r) => r.state === "caught");
const missed = results.filter((r) => r.state === "missed");
const skipped = results.filter((r) => r.state === "skipped");

const nW = 3;
const whatW = Math.max(20, ...results.map((r) => r.t.title.length + 2));
const expW = Math.max(12, ...results.map((r) => r.t.expect.join(", ").length + 2));
console.log(`\n${B("── Summary")}\n`);
console.log(
  `  ${"#".padEnd(nW)}${"WHAT WAS CHANGED".padEnd(whatW)}${"EXPECTED".padEnd(expW)}VERDICT`,
);
for (const r of results) {
  const verdict =
    r.state === "caught" ? "refused" : r.state === "skipped" ? RED("SKIPPED — not run") : RED("NOT CAUGHT");
  console.log(
    `  ${String(r.t.n).padEnd(nW)}${r.t.title.padEnd(whatW)}${r.t.expect.join(", ").padEnd(expW)}${verdict}`,
  );
}

if (!has("keep")) rmSync(dir, { recursive: true, force: true });
else console.log(`\n  ${DIM(`tampered copies left in ${dir}`)}`);

console.log("");
if (missed.length > 0) {
  console.log(
    `  ${RED(`${missed.length} of ${results.length} tampers did NOT produce the expected check.`)}`,
  );
  console.log("  That is a finding about the analyser, not about this script.\n");
  process.exit(1);
}
console.log(`  ${B(`${caught.length} of ${results.length} tampers refused by the named check`)}.`);
if (skipped.length > 0) {
  // Not an exit-1 condition — nothing was asserted and nothing failed — but it
  // must never be summed into the pass count, and the presenter has to know
  // which beats of the drill did not actually happen.
  console.log(
    `  ${RED(`${skipped.length} not run: ${skipped.map((r) => r.t.n).join(", ")} — the source artefact had nothing to tamper.`)}`,
  );
}
console.log(`  ${EXPECTED_CHECKS} checks ran every time, including the one that leaves the artefact.\n`);
process.exit(0);
