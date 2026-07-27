/** The eil CLI — the only task runner. Cross-platform by construction. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type pg from "pg";
import { connect, migrate } from "./db.js";
import { ingestDocs, runReconcile } from "./ingest/pipeline.js";

const program = new Command("eil").description("Enterprise Intelligence Layer CLI");

const db = program.command("db").description("Database management");
db.command("migrate")
  .description("Apply pending SQL migrations")
  .action(async () => {
    const client = await connect();
    try {
      const applied = await migrate(client);
      console.log(applied.length > 0 ? `applied: ${JSON.stringify(applied)}` : "up to date");
    } finally {
      await client.end();
    }
  });

db.command("embedded")
  .description(
    "Run an embedded Postgres in the foreground — real PG from node_modules, no system install",
  )
  .option("--dir <dir>", "data directory", ".eil-pg")
  .option("--port <port>", "port", "5433")
  .action(async (opts) => {
    let EmbeddedPostgres: any;
    try {
      const moduleName = "embedded-postgres"; // variable specifier: optional dep, resolved at runtime
      EmbeddedPostgres = (await import(moduleName)).default;
    } catch {
      console.log(
        "embedded-postgres is not installed. Add it with:\n  pnpm add -D embedded-postgres",
      );
      process.exit(1);
    }
    const port = Number(opts.port);
    const epg = new EmbeddedPostgres({
      databaseDir: opts.dir,
      user: "eil",
      password: "eil",
      port,
      persistent: true,
    });
    if (!existsSync(join(opts.dir, "PG_VERSION"))) await epg.initialise();
    await epg.start();
    const client = epg.getPgClient();
    await client.connect();
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'eil'");
    if (exists.rows.length === 0) await epg.createDatabase("eil");
    await client.end();
    console.log(`embedded Postgres running (data: ${opts.dir}, port: ${port})`);
    console.log(`  export EIL_DATABASE_URL=postgresql://eil:eil@localhost:${port}/eil`);
    console.log("press Ctrl+C to stop");
    const stop = async () => {
      await epg.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {}); // foreground until signalled
  });

function fixturePayloads(path: string): any[] {
  const payloads = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(payloads) ? payloads : [payloads];
}

/** Build a connector client with a clean one-line error when env is missing —
 * validated BEFORE any output, mirroring the original guard semantics. */
function liveClient<T>(build: () => T, requiredEnv: string): T {
  try {
    return build();
  } catch (err: any) {
    console.log(`live sync needs ${requiredEnv} set (personal credentials); ${err.message}`);
    process.exit(1);
  }
}

const ingest = program.command("ingest").description("Ingest sources into the catalog");

ingest
  .command("confluence")
  .description("Ingest Confluence — fixture, full CQL sync, or a selection (space/page/query)")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--space <keys>", "one or more space keys, comma-separated")
  .option("--page <ids>", "one or more page ids, comma-separated")
  .option("--with-descendants", "with --page: also ingest each page's subtree")
  .option("--query <cql>", "raw CQL predicate (advanced escape hatch)")
  .option("--reconcile", "after a FULL sync, delete catalog docs removed at the source")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { parseConfluenceScopes } = await import("./connectors/scope.js");
    let scopes: import("./connectors/scope.js").Scope[];
    try {
      scopes = parseConfluenceScopes(opts);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { normalize } = await import("./ingest/confluence.js");
    if (opts.fixture) {
      await ingestDocs(
        "confluence",
        fixturePayloads(opts.fixture).map((p) => normalize(p, opts.tenant)),
      );
      return;
    }
    const { ConfluenceClient } = await import("./connectors/confluence.js");
    const { ingestConfluenceScope } = await import("./ingest/pipeline.js");
    const conf = liveClient(
      () => new ConfluenceClient(),
      "EIL_CONFLUENCE_URL and EIL_CONFLUENCE_TOKEN",
    );
    for (const scope of scopes) await ingestConfluenceScope(conf, scope, opts.tenant);
    if (opts.reconcile) await runReconcile("confluence", () => conf.listIds(), opts.tenant);
  });

ingest
  .command("jira")
  .description("Ingest Jira — fixture, full JQL sync, or a selection (project/issue/query)")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--project <keys>", "one or more project keys, comma-separated")
  .option("--issue <keys>", "one or more issue keys, comma-separated")
  .option("--query <jql>", "raw JQL predicate (advanced escape hatch)")
  .option("--reconcile", "after a FULL sync, delete catalog docs removed at the source")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { parseJiraScopes } = await import("./connectors/scope.js");
    let scopes: import("./connectors/scope.js").Scope[];
    try {
      scopes = parseJiraScopes(opts);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { normalize } = await import("./ingest/jira.js");
    if (opts.fixture) {
      await ingestDocs(
        "jira",
        fixturePayloads(opts.fixture).map((p) => normalize(p, opts.tenant)),
      );
      return;
    }
    const { JiraClient } = await import("./connectors/jira.js");
    const { ingestJiraScope } = await import("./ingest/pipeline.js");
    const jira = liveClient(() => new JiraClient(), "EIL_JIRA_URL and EIL_JIRA_TOKEN");
    for (const scope of scopes) await ingestJiraScope(jira, scope, opts.tenant);
    if (opts.reconcile) await runReconcile("jira", () => jira.listIds(), opts.tenant);
  });

ingest
  .command("obsidian")
  .description("Ingest an Obsidian vault (markdown files; curated quality tier)")
  .requiredOption("--vault <dir>", "Vault root directory")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { walkVault } = await import("./ingest/obsidian.js");
    const docs = walkVault(opts.vault, opts.tenant);
    await ingestDocs("obsidian", docs);
    // The vault walk IS a full listing — reconcile deletions on every run.
    await runReconcile("obsidian", async () => docs.map((d) => d.id), opts.tenant);
  });

program
  .command("search <query>")
  .description("Debug: run search_docs through the tool registry (audited, like MCP)")
  .option("--limit <n>", "max results", "8")
  .action(async (query, opts) => {
    const { callTool } = await import("./tools.js");
    const result = await callTool("search_docs", { query, limit: Number(opts.limit) });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("eval")
  .description("Run the golden-query eval: recall@k through the real retrieval path")
  .option("--k <n>", "top-k", "10")
  .option("--min-recall <x>", "exit non-zero below this mean recall", "0")
  .option("--golden <path>", "golden queries file", "docs/golden-queries.md")
  .action(async (opts) => {
    const evalrun = await import("./evalrun.js");
    const { localViewer } = await import("./search.js");
    const entries = evalrun.parseGolden(opts.golden);
    if (entries.length === 0) {
      console.log(`no golden entries found in ${opts.golden}`);
      process.exit(1);
    }
    const client = await connect();
    try {
      const report = await evalrun.run(client, localViewer(), entries, Number(opts.k));
      await evalrun.record(client, report);
      for (const q of report.queries) {
        const marker = q.recall === 1.0 ? "ok " : "MISS";
        const missing = q.missing.length > 0 ? `  missing: ${JSON.stringify(q.missing)}` : "";
        console.log(`  ${marker} recall=${q.recall.toFixed(2)}  \`${q.query}\`${missing}`);
      }
      console.log(`mean recall@${report.k}: ${report.mean_recall} over ${entries.length} queries`);
      if (report.mean_recall < Number(opts.minRecall)) process.exit(2);
    } finally {
      await client.end();
    }
  });

program
  .command("audit")
  .description("Data-trust audit: catalog integrity invariants + optional live drift sampling")
  .option("--drift <n>", "sample N docs and compare against live source fetches", "0")
  .option("--strict", "exit non-zero if integrity invariants fail")
  .action(async (opts) => {
    const { drift, integrity } = await import("./quality.js");
    const client = await connect();
    try {
      const report: Record<string, unknown> = { integrity: await integrity(client) };
      const sample = Number(opts.drift);
      if (sample > 0) report.drift = await drift(client, sample);
      console.log(JSON.stringify(report, null, 2));
      if (opts.strict && !(report.integrity as { ok: boolean }).ok) process.exit(2);
    } finally {
      await client.end();
    }
  });

program
  .command("report")
  .description("Generate the self-contained HTML metrics report from the metrics views")
  .option("--out <path>", "output file", "docs/metrics-report.html")
  .action(async (opts) => {
    const r = await import("./report.js");
    const client = await connect();
    try {
      const html = r.render(await r.collect(client));
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, html, "utf-8");
      console.log(`wrote ${opts.out}`);
    } finally {
      await client.end();
    }
  });

program
  .command("tools")
  .description("Dump the tool manifest as JSON — for external hosts to index EIL's tools")
  .action(async () => {
    const { manifest } = await import("./tools.js");
    console.log(JSON.stringify(manifest(), null, 2));
  });

program
  .command("serve")
  .description(
    "Run the MCP server on stdio (wire this into Amp / Claude Code / the work connector)",
  )
  .action(async () => {
    const { serve } = await import("./mcp-server.js");
    await serve();
  });

program.parseAsync(process.argv);
