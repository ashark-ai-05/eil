/**
 * Regenerates the derived regions of docs/system-map.html from the code they
 * describe, so the diagram cannot silently drift out of date.
 *
 *   pnpm map:build    rewrite the generated regions in place
 *   pnpm map:check    fail if they are stale (for CI / pre-merge)
 *
 * The page is opened straight off disk via file://, where fetch() is blocked
 * by CORS — so the data is written *into* the HTML rather than loaded at
 * runtime. That keeps the page self-contained, keeps generated content visible
 * in review, and keeps it working with JS disabled.
 *
 * Each extractor throws when it matches nothing: a rotted pattern that quietly
 * produced an empty list would render a confident "0 tools", which is worse
 * than the drift this exists to prevent.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(ROOT, "docs", "system-map.html");

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const group1 = (m: RegExpMatchArray): string[] => (m[1] === undefined ? [] : [m[1]]);

function matchAll(label: string, source: string, re: RegExp): string[] {
  const found = [...source.matchAll(re)].flatMap(group1);
  if (found.length === 0) {
    throw new Error(
      `build-map: found no ${label}. The extraction pattern no longer matches its source — fix the pattern rather than shipping an empty list.`,
    );
  }
  return found;
}

// ── extract ────────────────────────────────────────────────────────────────

/** MCP tool names, from the ToolSpec registry that mcp-server.ts mounts. */
const tools = matchAll(
  "MCP tools in ts/tools.ts",
  read("ts/tools.ts"),
  /^\s*name: "([a-z_]+)",$/gm,
);

/**
 * metrics.vw_* views — the ones that ARE the metric definitions. A view can
 * be DROP + CREATE'd again in a later migration to fix a bug (0018's
 * vw_connector_health, 0023's tenant scoping) without changing its name, so
 * dedupe to the live set — first-seen order, since that is the order a
 * reader encounters the view's original purpose in migration history.
 */
const views = [
  ...new Set(
    readdirSync(join(ROOT, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .flatMap((f) =>
        [...read(`migrations/${f}`).matchAll(/CREATE\s+VIEW\s+metrics\.(vw_\w+)/gi)].flatMap(
          group1,
        ),
      ),
  ),
];
if (views.length === 0) throw new Error("build-map: found no metrics.vw_* views in migrations/");

/** Sources you can actually ingest, from the `eil ingest <x>` subcommands. */
const sources = matchAll(
  "ingest subcommands in ts/cli.ts",
  read("ts/cli.ts"),
  /^ingest\s*\n\s*\.command\("([a-z]+)/gm,
);

// ── render ─────────────────────────────────────────────────────────────────

const code = (xs: string[]) => xs.map((x) => `<code>${x}</code>`).join(" · ");

const REGIONS: Record<string, string> = {
  toolcount: `${tools.length} tools`,
  tools: `<p class="cap">${code(tools)}</p>`,
  views: `<p class="cap"><b>${views.length} views</b> — ${code(views)}</p>`,
  sources: `<p class="pnote"><b>Your credentials.</b> You can only index what you could already read. Ingest adapters: ${code(sources)}.</p>`,
};

// ── write ──────────────────────────────────────────────────────────────────

function apply(html: string): string {
  let out = html;
  for (const [name, body] of Object.entries(REGIONS)) {
    const re = new RegExp(`(<!--@gen:${name}-->)[\\s\\S]*?(<!--/@gen:${name}-->)`);
    if (!re.test(out)) {
      throw new Error(`build-map: no <!--@gen:${name}--> region in docs/system-map.html`);
    }
    out = out.replace(re, `$1${body}$2`);
  }
  return out;
}

const current = readFileSync(MAP, "utf8");
const next = apply(current);
const check = process.argv.includes("--check");

if (check) {
  if (current !== next) {
    console.error(
      "build-map: docs/system-map.html is STALE — run `pnpm map:build` and commit the result.",
    );
    process.exit(1);
  }
  console.log(
    `build-map: up to date (${tools.length} tools, ${views.length} views, ${sources.length} sources)`,
  );
} else {
  if (current === next) console.log("build-map: already up to date");
  else {
    writeFileSync(MAP, next);
    console.log("build-map: rewrote docs/system-map.html");
  }
  console.log(`  tools:   ${tools.join(", ")}`);
  console.log(`  views:   ${views.join(", ")}`);
  console.log(`  sources: ${sources.join(", ")}`);
}
