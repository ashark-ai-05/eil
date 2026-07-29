/** The eil CLI — the only task runner. Cross-platform by construction. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type pg from "pg";
import { connect, migrate } from "./db.js";
import { ingestDocs, runReconcile } from "./ingest/pipeline.js";
import { promptHidden } from "./prompt.js";

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
    if (opts.reconcile)
      await runReconcile(
        "confluence",
        async () => ({ ids: await conf.listIds(), complete: true }),
        opts.tenant,
      );
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
    if (opts.reconcile)
      await runReconcile(
        "jira",
        async () => ({ ids: await jira.listIds(), complete: true }),
        opts.tenant,
      );
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
    await runReconcile(
      "obsidian",
      async () => ({ ids: docs.map((d) => d.id), complete: true }),
      opts.tenant,
    );
  });

ingest
  .command("repo <refs...>")
  .description("Ingest one or more git repos (git clone or Bitbucket API) as code docs")
  .option("--source <kind>", "git | bitbucket (default: auto-detect per ref)")
  .option("--branch <b>", "branch", "main")
  .option("--subpath <p>", "restrict to a subdirectory")
  .option("--include <glob...>", "only paths matching (repeatable)")
  .option("--exclude <glob...>", "skip paths matching (repeatable)")
  .option("--name <key>", "override the repo key (else derived from the ref)")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (refs: string[], opts) => {
    const { detectSource, repoKey } = await import("./ingest/code.js");
    const { GitCloneSource, BitbucketApiSource } = await import("./connectors/reposource.js");
    const { RepoFilter } = await import("./ingest/repofilter.js");
    const { ingestRepo } = await import("./ingest/pipeline.js");
    if (opts.name && refs.length > 1) {
      console.log("--name cannot be used with multiple repos (it would collide their ids/cursors)");
      process.exit(1);
    }
    const filter = new RepoFilter({ includes: opts.include, excludes: opts.exclude });
    for (const ref of refs) {
      const kind = opts.source ?? detectSource(ref);
      const key = repoKey(ref, opts.name);
      const cfg = { ref, branch: opts.branch, subpath: opts.subpath };
      const source =
        kind === "bitbucket"
          ? liveClient(
              () => new BitbucketApiSource(cfg),
              "EIL_BITBUCKET_URL and EIL_BITBUCKET_TOKEN",
            )
          : new GitCloneSource(cfg);
      console.log(`ingest ${kind} ${key} (${ref})`);
      await ingestRepo(source, key, opts.subpath, filter, opts.tenant);
    }
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
  .command("eval:mine")
  .description("Promote real queries from audit_log into the labelled eval set")
  .option("--limit <n>", "max distinct queries to promote", "200")
  .action(async (opts) => {
    const { mineQueries } = await import("./eval/harness.js");
    const { localViewer } = await import("./search.js");
    const client = await connect();
    try {
      const v = localViewer();
      const added = await mineQueries(client, { limit: Number(opts.limit), tenant: v.tenant });
      const total = await client.query(
        "SELECT origin, count(*)::int AS n FROM eval_queries WHERE tenant = $1 GROUP BY origin ORDER BY origin",
        [v.tenant],
      );
      console.log(`promoted ${added} new queries`);
      for (const r of total.rows) console.log(`  ${r.origin.padEnd(10)} ${r.n}`);
      const unjudged = await client.query(
        "SELECT count(*)::int AS n FROM eval_queries q WHERE q.tenant = $1" +
          " AND NOT EXISTS (SELECT 1 FROM eval_qrels r WHERE r.query_id = q.id)",
        [v.tenant],
      );
      if (unjudged.rows[0].n > 0)
        console.log(
          `\n${unjudged.rows[0].n} queries have no judgments yet — they run but do not score.`,
        );
    } finally {
      await client.end();
    }
  });

program
  .command("eval:run")
  .description("Score the labelled set through the real retrieval path")
  .option("--persist", "store the run for later comparison")
  .option("--min-ndcg <x>", "exit non-zero below this mean nDCG@10", "0")
  .action(async (opts) => {
    const { runEval } = await import("./eval/harness.js");
    const { localViewer } = await import("./search.js");
    const client = await connect();
    try {
      const r = await runEval(client, localViewer(), {
        persist: !!opts.persist,
        gitSha: process.env.GITHUB_SHA ?? "local",
      });
      if (r.judged === 0) {
        console.log(`${r.queries} queries, none judged yet — nothing to score.`);
        console.log("Add rows to eval_qrels, or run `eil eval:mine` then judge the pool.");
        return;
      }
      const pct = (x: number) => (Number.isNaN(x) ? "  n/a" : x.toFixed(4));
      const runTag = r.runId ? ` (run ${r.runId})` : "";
      console.log(`scored ${r.judged} of ${r.queries} queries${runTag}`);
      console.log(`  recall@50  ${pct(r.recall50)}   <- headroom`);
      console.log(`  recall@10  ${pct(r.recall10)}   <- delivered`);
      console.log(`  nDCG@10    ${pct(r.ndcg10)}`);
      console.log(`  MRR        ${pct(r.mrr)}`);
      console.log(
        `  judged@10  ${pct(r.judged10)}${r.judged10 < 0.8 ? "   <- BELOW 0.8: scores are not trustworthy, top up the pool" : ""}`,
      );
      const synth = r.mix.synthetic;
      if (synth > r.judged / 2)
        console.log(
          `\nNOTE: ${synth}/${r.queries} queries are synthetic. A query generated from a chunk\nechoes that chunk, so this set CANNOT be used to compare chunkers.`,
        );
      if (r.ndcg10 < Number(opts.minNdcg)) process.exit(2);
    } finally {
      await client.end();
    }
  });

program
  .command("eval:judge")
  .description("Build the judging pool; export a worksheet, import it back, or judge with a model")
  .option("--export <path>", "write unjudged pairs as an editable worksheet")
  .option("--import <path>", "read graded worksheet back into eval_qrels")
  .option("--llm", "grade the pool with the configured LLM provider")
  .option("--depth <n>", "pool depth per query", "20")
  .action(async (opts) => {
    const { applyJudgments, buildPool, exportPool, judgeWithLlm, parseJudgments } = await import(
      "./eval/judge.js"
    );
    const { localViewer } = await import("./search.js");
    const client = await connect();
    try {
      const v = localViewer();
      if (opts.import) {
        const parsed = parseJudgments(readFileSync(opts.import, "utf-8"));
        const added = await applyJudgments(client, parsed, v.principal);
        console.log(`${parsed.length} grades read, ${added} new (existing left untouched)`);
        return;
      }
      const pool = await buildPool(client, v, Number(opts.depth));
      if (pool.length === 0) {
        console.log("nothing to judge — every retrieved document already has a grade.");
        console.log("Run `eil eval:mine` for more queries, or raise --depth.");
        return;
      }
      if (opts.llm) {
        const { getProvider } = await import("./llm/index.js");
        const provider = getProvider();
        console.log(`judging ${pool.length} pairs with ${provider.name}...`);
        const { judgments, failed } = await judgeWithLlm(pool, provider, (d, t) => {
          if (d % 10 === 0 || d === t) process.stdout.write(`\r  ${d}/${t}`);
        });
        process.stdout.write("\n");
        const added = await applyJudgments(client, judgments, `llm:${provider.name}`);
        console.log(
          `${added} grades written${failed > 0 ? `, ${failed} skipped (see above)` : ""}`,
        );
        return;
      }
      const out = opts.export ?? "judgments.md";
      writeFileSync(out, exportPool(pool));
      console.log(`${pool.length} unjudged pairs -> ${out}`);
      console.log(`Fill in each \`grade: ?\`, then: eil eval:judge --import ${out}`);
    } finally {
      await client.end();
    }
  });

program
  .command("eval:compare <baseline> <candidate>")
  .description("Paired permutation test between two stored eval runs")
  .option("--metric <m>", "ndcg_10 | recall_10 | recall_50 | mrr", "ndcg_10")
  .action(async (baseline: string, candidate: string, opts) => {
    const { compareRuns } = await import("./eval/harness.js");
    const { pairedPermutationTest } = await import("./eval/metrics.js");
    const client = await connect();
    try {
      const { a, b } = await compareRuns(client, Number(baseline), Number(candidate), opts.metric);
      if (a.length === 0) {
        console.log("no overlapping queries between those runs");
        process.exit(1);
      }
      const { meanDelta, p } = pairedPermutationTest(a, b);
      console.log(`${opts.metric}: ${a.length} paired queries`);
      console.log(`  delta ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(4)}`);
      console.log(
        `  p     ${p.toFixed(4)}${p < 0.05 ? "  <- significant" : "  <- NOT significant, do not merge on this"}`,
      );
    } finally {
      await client.end();
    }
  });

const ivf = program
  .command("ivf")
  .description("Coarse vector index: bit signatures, IVF clusters, nprobe calibration");

ivf
  .command("build")
  .description("Compute signatures, cluster the corpus, and calibrate nprobe")
  .option("--nlist <n>", "clusters (default: sqrt(corpus))")
  .option("--skip-calibrate", "build only; calibrate separately")
  .action(async (opts) => {
    const { getEmbedder } = await import("./embed/index.js");
    const { backfillSignatures, buildCentroids, calibrate } = await import("./embed/buildivf.js");
    const { RECALL_GATE } = await import("./embed/ivf.js");
    const client = await connect();
    try {
      const emb = getEmbedder();
      console.log(`model ${emb.id}`);
      const sig = await backfillSignatures(client, emb.id);
      console.log(`signatures written: ${sig.written}`);
      const built = await buildCentroids(client, emb.id, {
        ...(opts.nlist ? { nlist: Number(opts.nlist) } : {}),
      });
      console.log(`nlist ${built.nlist}, assigned ${built.assigned}`);
      if (opts.skipCalibrate || built.nlist === 0) return;
      const cal = await calibrate(client, emb);
      console.log("\n  nprobe   recall@10   scanned/query");
      for (const p of cal.points)
        console.log(
          `  ${String(p.nprobe).padStart(6)}   ${p.recall10.toFixed(4)}      ${String(p.scanned).padStart(7)}`,
        );
      if (cal.chosen === null) {
        console.log(
          `\nNO nprobe reached recall@10 >= ${RECALL_GATE}. Keeping the exact scan —\nthis corpus's geometry does not suit IVF at this size.`,
        );
        return;
      }
      console.log(`\nchosen nprobe ${cal.chosen} (smallest clearing ${RECALL_GATE})`);
    } finally {
      await client.end();
    }
  });

ivf
  .command("status")
  .description("Show the coarse index state and the calibration that chose nprobe")
  .action(async () => {
    const { getEmbedder } = await import("./embed/index.js");
    const { chosenNprobe } = await import("./embed/buildivf.js");
    const client = await connect();
    try {
      const emb = getEmbedder();
      const cov = await client.query(
        "SELECT count(*)::int AS embedded," +
          " count(*) FILTER (WHERE sig IS NOT NULL)::int AS signed," +
          " count(*) FILTER (WHERE cluster_id IS NOT NULL)::int AS clustered" +
          " FROM chunks WHERE embedding IS NOT NULL AND embed_model = $1",
        [emb.id],
      );
      const c = cov.rows[0];
      const cents = await client.query(
        "SELECT count(*)::int AS n FROM ivf_centroids WHERE embed_model = $1",
        [emb.id],
      );
      const nprobe = await chosenNprobe(client, emb.id);
      console.log(`model      ${emb.id}`);
      console.log(`embedded   ${c.embedded}`);
      console.log(
        `signed     ${c.signed}${c.signed < c.embedded ? "  <- run `eil ivf build`" : ""}`,
      );
      console.log(`clustered  ${c.clustered}`);
      console.log(`centroids  ${cents.rows[0].n}`);
      console.log(`nprobe     ${nprobe ?? "not calibrated — queries use the exact scan"}`);
    } finally {
      await client.end();
    }
  });

program
  .command("stats:refresh")
  .description("Recompute BM25 corpus statistics (document frequency, N, avgdl)")
  .action(async () => {
    const { refreshStats } = await import("./core/stats.js");
    const client = await connect();
    try {
      const s = await refreshStats(client);
      console.log(`lexemes ${s.lexemes}  chunks ${s.nChunks}  avg length ${s.avgLen.toFixed(1)}`);
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
    const { drift, integrity, recordHealth } = await import("./quality.js");
    const client = await connect();
    try {
      const integrityReport = await integrity(client);
      const report: Record<string, unknown> = { integrity: integrityReport };
      await recordHealth(client, "integrity", integrityReport.ok, integrityReport);
      const sample = Number(opts.drift);
      if (sample > 0) {
        const driftReport = await drift(client, sample);
        report.drift = driftReport;
        await recordHealth(client, "drift", driftReport.gone.length === 0, driftReport);
      }
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

// Resolves `source` to its keychain account name, or prints the error and exits(1)
// if `source` isn't recognized. Shared by `login` and `logout`.
async function requireAccount(source: string): Promise<string> {
  const { SOURCES } = await import("./connectors/keychain.js");
  const account = SOURCES[source];
  if (!account) {
    console.log(`unknown source '${source}'. valid: ${Object.keys(SOURCES).join(", ")}`);
    process.exit(1);
  }
  return account;
}

auth
  .command("login <source>")
  .description("Store a connector token in the OS keychain (jira|confluence|bitbucket|elk)")
  .option("--stdin", "read the token from stdin instead of an interactive prompt")
  .action(async (source, opts) => {
    const account = await requireAccount(source);
    const { keychainBackend, setSecret } = await import("./connectors/keychain.js");
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
    try {
      setSecret(account, token);
    } catch (err: any) {
      console.log(`could not store ${account}: ${err.message}`);
      process.exit(1);
    }
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
    const account = await requireAccount(source);
    const { deleteSecret } = await import("./connectors/keychain.js");
    try {
      deleteSecret(account);
    } catch (err: any) {
      console.log(`could not remove ${account}: ${err.message}`);
      process.exit(1);
    }
    console.log(`removed ${account} from the keychain`);
  });

const embed = program.command("embed").description("Embeddings for semantic search");
embed
  .command("backfill")
  .description("Embed catalog chunks so search gains a semantic (vector) arm")
  .option("--batch <n>", "batch size", "64")
  .option("--reembed", "re-embed every chunk (e.g. after changing the model)")
  .action(async (opts) => {
    const { getEmbedder } = await import("./embed/index.js");
    const { backfill } = await import("./embed/backfill.js");
    const embedder = getEmbedder();
    const client = await connect();
    try {
      const r = await backfill(client, embedder, {
        batch: Number(opts.batch),
        reembed: !!opts.reembed,
      });
      console.log(`embedded ${r.embedded} chunks (provider ${embedder.id})`);
    } finally {
      await client.end();
    }
  });

program.parseAsync(process.argv);
