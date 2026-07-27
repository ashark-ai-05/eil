/** The eil CLI — the only task runner. Cross-platform by construction. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import type pg from "pg";
import type { CanonicalDoc } from "./contracts/models.js";
import { connect, migrate } from "./db.js";

const program = new Command("eil").description("Enterprise Intelligence Layer CLI");

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout;
    // Mute echo: intercept writes while reading the answer.
    const mutedWrite = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(label)) out.write(s);
    };
    rl.question(`${label}: `, (answer) => {
      (rl as any)._writeToOutput = mutedWrite;
      out.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

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

interface IngestOutcome {
  seen: number;
  changed: number;
  failed: number;
  target: string | null;
}

async function ingestDocs(
  source: string,
  docs: AsyncIterable<CanonicalDoc> | Iterable<CanonicalDoc>,
  cursorOf?: (doc: CanonicalDoc) => string | null,
): Promise<void> {
  const { setCursor, upsertDocument } = await import("./store.js");
  const client = await connect();
  const outcome: IngestOutcome = { seen: 0, changed: 0, failed: 0, target: null };
  let latest: string | null = null;
  let retryFrom: string | null = null; // earliest failed timestamp — cursor never passes it
  try {
    for await (const doc of docs) {
      outcome.seen += 1;
      const value = cursorOf ? cursorOf(doc) : null;
      try {
        // upsertDocument owns its transaction — per-doc commit, so one bad
        // record can't starve the batch.
        if (await upsertDocument(client, doc)) {
          outcome.changed += 1;
          console.log(`  ~ ${doc.id}`);
        }
      } catch (err: any) {
        outcome.failed += 1;
        console.log(`  ! failed (${err.constructor?.name ?? "Error"}): ${err.message}`);
        if (value && (retryFrom === null || value < retryFrom)) retryFrom = value;
        continue;
      }
      if (value && (latest === null || value > latest)) latest = value;
    }
    // Advance to the newest success, but never beyond the earliest failure.
    outcome.target = retryFrom ?? latest;
    if (outcome.target) await setCursor(client, source, outcome.target);
  } finally {
    await client.end();
  }
  let summary = `${outcome.seen} seen, ${outcome.changed} changed`;
  if (outcome.failed > 0)
    summary += `, ${outcome.failed} FAILED (cursor held at ${outcome.target})`;
  else if (latest) summary += `, cursor -> ${latest}`;
  console.log(summary);
}

function fixturePayloads(path: string): any[] {
  const payloads = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(payloads) ? payloads : [payloads];
}

/** Full-listing reconcile (flow K1 deletions): fetch the complete id list
 * from the source and tombstone catalog docs that no longer exist there. */
async function runReconcile(
  source: string,
  listIds: () => Promise<string[]>,
  tenant: string,
): Promise<void> {
  console.log(`reconcile: fetching full ${source} id listing...`);
  const present = await listIds();
  const { reconcile } = await import("./store.js");
  const client = await connect();
  try {
    const removed = await reconcile(client, source, present, tenant);
    for (const id of removed) console.log(`  - ${id} (deleted at source)`);
    console.log(`reconcile: ${present.length} present at source, ${removed.length} removed`);
  } finally {
    await client.end();
  }
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
  .description("Ingest Confluence pages — fixture JSON, or live CQL sync from the cursor")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--reconcile", "after sync, delete catalog docs removed at the source (full id listing)")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { normalize } = await import("./ingest/confluence.js");
    if (opts.fixture) {
      await ingestDocs(
        "confluence",
        fixturePayloads(opts.fixture).map((p) => normalize(p, opts.tenant)),
      );
      return;
    }
    const { ConfluenceClient } = await import("./connectors/confluence.js");
    const { getCursor } = await import("./store.js");
    const conf = liveClient(
      () => new ConfluenceClient(),
      "EIL_CONFLUENCE_URL and EIL_CONFLUENCE_TOKEN",
    );
    const client = await connect();
    const cursor = await getCursor(client, "confluence");
    await client.end();
    console.log(`live sync from cursor: ${cursor ?? "(beginning)"}`);
    const docs = (async function* () {
      for await (const page of conf.updatedSince(cursor)) yield normalize(page, opts.tenant);
    })();
    await ingestDocs("confluence", docs, (d) => d.updatedAt ?? null);
    if (opts.reconcile) await runReconcile("confluence", () => conf.listIds(), opts.tenant);
  });

ingest
  .command("jira")
  .description("Ingest Jira issues — fixture JSON, or live JQL sync from the cursor")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--reconcile", "after sync, delete catalog docs removed at the source (full id listing)")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { normalize } = await import("./ingest/jira.js");
    if (opts.fixture) {
      await ingestDocs(
        "jira",
        fixturePayloads(opts.fixture).map((p) => normalize(p, opts.tenant)),
      );
      return;
    }
    const { JiraClient } = await import("./connectors/jira.js");
    const { getCursor } = await import("./store.js");
    const jira = liveClient(() => new JiraClient(), "EIL_JIRA_URL and EIL_JIRA_TOKEN");
    const client = await connect();
    const cursor = await getCursor(client, "jira");
    await client.end();
    console.log(`live sync from cursor: ${cursor ?? "(beginning)"}`);
    const docs = (async function* () {
      for await (const issue of jira.updatedSince(cursor)) yield normalize(issue, opts.tenant);
    })();
    await ingestDocs("jira", docs, (d) => d.updatedAt ?? null);
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

const auth = program.command("auth").description("Manage connector tokens in the OS keychain");

auth
  .command("login <source>")
  .description("Store a connector token in the OS keychain (jira|confluence|bitbucket|elk)")
  .option("--stdin", "read the token from stdin instead of an interactive prompt")
  .action(async (source, opts) => {
    const { SOURCES, keychainBackend, setSecret } = await import("./connectors/keychain.js");
    const account = SOURCES[source];
    if (!account) {
      console.log(`unknown source '${source}'. valid: ${Object.keys(SOURCES).join(", ")}`);
      process.exit(1);
    }
    const backend = keychainBackend();
    if (!backend.available) {
      console.log(
        `no keychain backend available (${backend.name}) — install libsecret-tools (Linux) or set ${account} directly`,
      );
      process.exit(1);
    }
    const token = opts.stdin
      ? readFileSync(0, "utf-8").trim()
      : await promptHidden(`${source} token`);
    if (!token) {
      console.log("no token provided");
      process.exit(1);
    }
    setSecret(account, token);
    console.log(`stored ${account} in the ${backend.name} keychain`);
  });

auth
  .command("status")
  .description("Show where each connector token resolves from (never prints secrets)")
  .action(async () => {
    const { SOURCES, getSecret, keychainBackend, resolvedSource } = await import(
      "./connectors/keychain.js"
    );
    const backend = keychainBackend();
    console.log(`keychain backend: ${backend.name} (available: ${backend.available})`);
    for (const [source, account] of Object.entries(SOURCES)) {
      const from = resolvedSource(account, process.env, getSecret);
      console.log(`  ${source.padEnd(11)} ${account.padEnd(22)} <- ${from}`);
    }
  });

auth
  .command("logout <source>")
  .description("Remove a connector token from the OS keychain")
  .action(async (source) => {
    const { SOURCES, deleteSecret } = await import("./connectors/keychain.js");
    const account = SOURCES[source];
    if (!account) {
      console.log(`unknown source '${source}'. valid: ${Object.keys(SOURCES).join(", ")}`);
      process.exit(1);
    }
    deleteSecret(account);
    console.log(`removed ${account} from the keychain`);
  });

program.parseAsync(process.argv);
