#!/usr/bin/env node
/** The eil CLI — the only task runner. Cross-platform by construction. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type pg from "pg";
import { type Db, connect, dsn, migrate, provisionRuntimeRoles } from "./db.js";
import { promptHidden } from "./prompt.js";
import type { Finding, ReqsBody } from "./reqs/schema.js";

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

db.command("provision-runtime-roles")
  .description("Create the cluster-wide API and connector-worker privilege roles")
  .action(async () => {
    const client = await connect();
    try {
      await provisionRuntimeRoles(client);
      console.log("runtime roles provisioned (login users and passwords remain operator-managed)");
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
        "embedded-postgres is not installed. Reinstall EIL with optional dependencies enabled.",
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

/**
 * The single ingest entry point: resolve a spec from the registry and run it.
 *
 * Every `eil ingest <source>` command routes through here, so the registry is
 * the ONE inventory of what EIL can ingest rather than one list in the registry
 * and a second implied by which commands happen to exist. Client construction,
 * environment validation and reconcile all live in the spec; this function
 * knows nothing about any particular source.
 *
 * Named sources are looked up rather than imported, so a command naming a
 * source with no spec fails loudly here instead of silently doing nothing.
 */
async function dispatch(name: string, opts: Record<string, unknown>): Promise<void> {
  const { REGISTRY, runSource } = await import("./ingest/registry.js");
  const spec = REGISTRY[name];
  if (!spec) {
    console.log(
      `unknown source "${name}" (registered: ${Object.keys(REGISTRY).sort().join(", ")})`,
    );
    process.exit(1);
  }
  try {
    await runSource(spec, { tenant: "default", ...opts } as never);
  } catch (err: any) {
    console.log(err.message);
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
  .option("--attachments", "also store original attachment bytes (increases backup size)")
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
    await dispatch("confluence", { ...opts, scopes });
  });

ingest
  .command("jira")
  .description("Ingest Jira — fixture, full JQL sync, or a selection (project/issue/query)")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--project <keys>", "one or more project keys, comma-separated")
  .option("--issue <keys>", "one or more issue keys, comma-separated")
  .option("--query <jql>", "raw JQL predicate (advanced escape hatch)")
  .option("--reconcile", "after a FULL sync, delete catalog docs removed at the source")
  .option("--attachments", "also store original attachment bytes (increases backup size)")
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
    await dispatch("jira", { ...opts, scopes });
  });

ingest
  .command("obsidian")
  .description("Ingest an Obsidian vault (markdown files; curated quality tier)")
  .requiredOption("--vault <dir>", "Vault root directory")
  .option("--acl-group <g...>", "groups granted read; omit for owner-only (fail-closed)")
  .option("--follow-symlinks", "follow symlinks that stay inside --vault (default: skip them)")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    await dispatch("obsidian", opts);
  });

ingest
  .command("files")
  .description("Ingest a directory tree of markdown files (identified by --collection)")
  .requiredOption("--root <dir>", "Directory to walk")
  .requiredOption("--collection <name>", "Stable collection name; part of every document id")
  .option("--acl-group <g...>", "groups granted read; omit for owner-only (fail-closed)")
  .option("--follow-symlinks", "follow symlinks that stay inside --root (default: skip them)")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    await dispatch("filesystem", opts);
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
  .option(
    "--acl-group <g...>",
    "groups granted read on this repo; omit for owner-only (fail-closed)",
  )
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (refs: string[], opts) => {
    if (opts.name && refs.length > 1) {
      console.log("--name cannot be used with multiple repos (it would collide their ids/cursors)");
      process.exit(1);
    }
    await dispatch("code", { ...opts, refs });
  });

program
  .command("search <query>")
  .description("Debug: run search_docs through the tool registry (audited, like MCP)")
  .option("--limit <n>", "max results", "8")
  .option(
    "--source <kind...>",
    "restrict to these sources (confluence | jira | code | obsidian); omit for all",
  )
  .action(async (query, opts) => {
    const { callTool } = await import("./tools.js");
    const result = await callTool("search_docs", {
      query,
      limit: Number(opts.limit),
      ...(opts.source ? { sources: opts.source } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("index:stats")
  .description("What is in the index, and the SQL that scores it — read-only")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    const { runIndexStats, formatIndexStats } = await import("./indexstats.js");
    const stats = await runIndexStats();
    console.log(opts.json ? JSON.stringify(stats, null, 2) : formatIndexStats(stats));
  });

program
  .command("context-cost <query...>")
  .description("Measure context spent: every match in full vs two-phase search-then-fetch")
  .option("--limit <n>", "results the search returns", "8")
  .option("--fetch <n>", "documents the agent is assumed to open", "1")
  .option("--json", "machine-readable output")
  .action(async (queries: string[], opts) => {
    const { runContextCost, formatContextCost } = await import("./contextcost.js");
    const reports = await runContextCost(queries, Number(opts.limit), Number(opts.fetch));
    if (opts.json) {
      console.log(JSON.stringify(reports, null, 2));
      return;
    }
    console.log(reports.map(formatContextCost).join("\n\n"));
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
      console.log(`\ncalibrated on ${cal.queries} queries`);
      // Measured at a FULL probe, so there is no cluster loss here — whatever is
      // missing is purely what binary quantization discarded.
      console.log("\n  oversample   recall@10   (full probe: quantization loss only)");
      for (const o of cal.oversamplePoints)
        console.log(`  ${String(`${o.oversample}x`).padStart(10)}   ${o.recall10.toFixed(4)}`);
      console.log(`\n  -> oversample ${cal.oversample}\n`);
      console.log("  nprobe   recall@10   scanned/query");
      for (const p of cal.points)
        console.log(
          `  ${String(p.nprobe).padStart(6)}   ${p.recall10.toFixed(4)}      ${String(p.scanned).padStart(7)}`,
        );
      if (cal.chosen === null) {
        console.log(
          `\nNo PARTIAL probe reached recall@10 >= ${RECALL_GATE}, so IVF is not adopted and\nqueries keep the exact scan. That is the gate working: at this corpus size the\nclusters are too small for the true neighbours to co-locate. Re-run as the\ncorpus grows.`,
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
          " FROM chunk_vectors WHERE embed_model = $1",
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
  .command("prune")
  .description("Apply retention: trim fact tables and purge expired quarantine")
  .option("--older-than <days>", "retain this many days of facts", "90")
  .option("--dry-run", "report what would be removed, change nothing")
  .action(async (opts) => {
    const days = Number(opts.olderThan);
    if (!Number.isFinite(days) || days < 1) {
      console.log("--older-than must be a positive number of days");
      process.exit(1);
    }
    const client = await connect();
    try {
      // audit_log, retrieval_events and document_revisions all grow one row per
      // event forever. Step 0 added two of them; shipping unbounded growth is
      // not a design, and the metrics views scan these tables on every dashboard
      // load.
      const targets: Array<[string, string]> = [
        ["audit_log", `DELETE FROM audit_log WHERE at < now() - interval '${days} days'`],
        [
          "retrieval_events",
          `DELETE FROM retrieval_events WHERE at < now() - interval '${days} days'`,
        ],
        [
          "document_revisions",
          // Keep the CURRENT revision of every document regardless of age —
          // pruning history must never orphan a document's present state.
          `DELETE FROM document_revisions r WHERE r.captured_at < now() - interval '${days} days' AND EXISTS (SELECT 1 FROM documents d WHERE d.tenant = r.tenant AND d.id = r.doc_id AND d.revision > r.revision)`,
        ],
        [
          "metrics.health_runs",
          `DELETE FROM metrics.health_runs WHERE at < now() - interval '${days} days'`,
        ],
      ];
      for (const [name, sql] of targets) {
        const count = await client.query(
          sql.replace(/^DELETE FROM (\S+)( \S+)?/, "SELECT count(*)::int AS n FROM $1$2"),
        );
        const n = Number(count.rows[0]?.n ?? 0);
        if (!opts.dryRun && n > 0) await client.query(sql);
        console.log(`  ${name.padEnd(22)} ${opts.dryRun ? "would remove" : "removed"} ${n}`);
      }
      // quarantine_until has been written and cleared since migration 0010 and
      // never READ, so a source-deleted document's body was retained forever —
      // a compliance regression against the hard delete it replaced.
      //
      // Delegated rather than inlined: attachments reference documents with
      // ON DELETE RESTRICT, so removing a document now requires removing its
      // evidence first, in one transaction, in that order.
      const { purgeExpiredQuarantine } = await import("./purge.js");
      const purged = await purgeExpiredQuarantine(client, { dryRun: Boolean(opts.dryRun) });
      const verb = opts.dryRun ? "would purge" : "purged";
      console.log(`  ${"quarantine expired".padEnd(22)} ${verb} ${purged.documents}`);
      if (purged.artifactVersions > 0 || purged.artifactBlobs > 0)
        console.log(
          `  ${"  attachments".padEnd(22)} ${verb} ${purged.artifactVersions} reference(s), ` +
            `${purged.artifactBlobs} blob(s)`,
        );
    } finally {
      await client.end();
    }
  });

program
  .command("demo:preflight")
  .description("Check everything the demo needs BEFORE you are standing in front of people")
  .option("--repo <path>", "also check a local git repository")
  .action(async (opts) => {
    const { preflight, worstState } = await import("./demo.js");
    const checks = await preflight(opts.repo ? { repo: String(opts.repo) } : {});
    const mark = { ok: "ok  ", warn: "WARN", fail: "FAIL", skip: "--  " } as const;
    for (const c of checks) {
      console.log(`${mark[c.state]} ${c.name.padEnd(13)} ${c.detail}`);
      if (c.fix) console.log(`         ${" ".repeat(13)} -> ${c.fix}`);
    }
    const worst = worstState(checks);
    console.log(
      worst === "fail"
        ? "\nNOT READY — fix the FAIL lines above."
        : worst === "warn"
          ? "\nUsable, but read the WARN lines."
          : "\nReady.",
    );
    if (worst === "fail") process.exit(2);
  });

const quarantine = program
  .command("quarantine")
  .description("Review documents held back because they appear to contain credentials");

quarantine
  .command("list")
  .description("The remediation worklist — rule and location only, never the secret")
  .action(async () => {
    const client = await connect();
    try {
      const res = await client.query(
        "SELECT id, title, url, secret_findings, quarantined_at FROM documents" +
          " WHERE quarantined_at IS NOT NULL ORDER BY quarantined_at DESC, id",
      );
      if (res.rows.length === 0) {
        console.log("nothing quarantined.");
        return;
      }
      for (const r of res.rows) {
        console.log(`\n${r.id}`);
        console.log(`  ${r.title ?? "(untitled)"}${r.url ? `  ${r.url}` : ""}`);
        for (const f of r.secret_findings ?? []) {
          // hint is first+last 4 chars: enough to find it at the source, not to use it
          console.log(`  ${String(f.rule).padEnd(28)} ${f.hint}  @${f.start}`);
        }
      }
      console.log(
        `\n${res.rows.length} quarantined. Remediate at the SOURCE, then re-ingest — or, if a\nfinding is a false positive (a test fixture, documentation), clear it:\n  eil quarantine clear <id>`,
      );
    } finally {
      await client.end();
    }
  });

quarantine
  .command("clear <id>")
  .description("Accept the findings as false positives and return the document to the index")
  .action(async (id: string) => {
    const client = await connect();
    try {
      // Record the CURRENT findings as accepted before re-ingesting. Clearing the
      // flag alone does not work: the re-ingest re-runs the scanner, which finds
      // the same key-shaped string and quarantines it again. Acceptance is keyed
      // on rule + hint, so a DIFFERENT credential appearing later is still caught.
      const res = await client.query(
        // MERGE, never replace. `secret_accepted = secret_findings` looked right
        // and silently wiped earlier acceptances: after a clear, secret_findings
        // is NULL, so a second clear on a re-quarantined document set accepted
        // back to NULL and the file could never be released. Accumulating means
        // repeated review converges instead of oscillating; duplicates are
        // harmless because the comparison is a set.
        "UPDATE documents SET quarantined_at = NULL," +
          " secret_accepted = coalesce(secret_accepted, '[]'::jsonb)" +
          "                   || coalesce(secret_findings, '[]'::jsonb)," +
          " secret_findings = NULL, secret_reviewed_at = now(), secret_reviewed_by = $2," +
          // Clear the content hash so the re-ingest below falls THROUGH the hash
          // gate. Accepting a finding does not change the body, so the gate would
          // otherwise short-circuit and the document would come back unflagged
          // and still unchunked — invisible to search, which is the state we are
          // trying to leave.
          "     content_hash = ''" +
          " WHERE id = $1 AND quarantined_at IS NOT NULL RETURNING tenant, id, source",
        [id, userInfo().username],
      );
      if (res.rows.length === 0) {
        console.log(`${id} is not quarantined.`);
        return;
      }
      // Clearing the flag is not enough: the document was never chunked, so it
      // would be visible to getDoc and absent from every search. Re-chunking is
      // what actually returns it to the index, and it needs the body we kept.
      const doc = await client.query(
        "SELECT id, tenant, source, title, url, author, created_at, updated_at, hierarchy," +
          " acl_groups, quality_tier, body FROM documents WHERE id = $1",
        [id],
      );
      const d = doc.rows[0];
      const { upsertDocument } = await import("./store.js");
      const { CanonicalDoc } = await import("./contracts/models.js");
      await upsertDocument(
        client,
        CanonicalDoc.parse({
          id: d.id,
          tenant: d.tenant,
          source: d.source,
          title: d.title,
          url: d.url,
          author: d.author,
          createdAt: d.created_at ? new Date(d.created_at).toISOString() : null,
          updatedAt: d.updated_at ? new Date(d.updated_at).toISOString() : null,
          hierarchy: d.hierarchy ?? [],
          aclGroups: d.acl_groups ?? [],
          qualityTier: d.quality_tier,
          body: d.body,
        }),
      );
      const again = await client.query("SELECT quarantined_at FROM documents WHERE id = $1", [id]);
      if (again.rows[0]?.quarantined_at) {
        console.log(
          `${id} is STILL quarantined — the scanner found a credential that was not among\nthe accepted findings. Accepting one finding does not accept the next.`,
        );
        return;
      }
      console.log(`${id} accepted as a false positive, re-chunked and searchable again.`);
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

const reqs = program
  .command("reqs")
  .description("Gated requirements artefacts: run the gate, project them for humans");

/**
 * Open the catalog so citation verification (CLARIFY-005) can re-read every
 * cited document through the audited tool path.
 *
 * A presenter whose database is not up must still get a usable refusal, so a
 * catalog that cannot be reached degrades to running WITHOUT a resolver:
 * CLARIFY-005 is then SKIPPED rather than passed — it drops out of `checksRun`,
 * so the count itself records the omission — and the omission is announced on
 * stderr, where it cannot be mistaken for a finding on stdout.
 *
 * The readiness probe reads no document: it only asks whether the catalog's
 * schema exists. Every actual document fetch goes through callTool.
 */
async function openReqsCatalog(): Promise<{
  client: Db | null;
  resolveOpt: { resolveDoc?: (docId: string) => Promise<string | null> };
}> {
  let client: Db | null = null;
  try {
    client = await connect();
    await client.query("SELECT 1 FROM documents LIMIT 1");
    const { localViewer } = await import("./search.js");
    const { makeDocResolver } = await import("./reqs/io.js");
    return { client, resolveOpt: { resolveDoc: makeDocResolver(client, localViewer()) } };
  } catch (err: any) {
    if (client) await client.end().catch(() => {});
    const cause = String(err?.message ?? err).split("\n")[0];
    const skipped = "SKIPPED: no cited quote was re-read from a document on this run";
    console.error(`no catalog (${cause}) — CLARIFY-005 ${skipped}`);
    return { client: null, resolveOpt: {} };
  }
}

/**
 * Exit with a code that SURVIVES.
 *
 * `process.exitCode = 1` and a natural exit is not enough: the PGlite (WASM)
 * backend resets the pending exit code when it closes, so `reqs check` printed
 * REFUSED and exited 0 on the zero-install demo path — a gate that reports
 * failure and returns success is worse than no gate at all. And a bare
 * `process.exit()` is not enough either: stdout to a pipe is asynchronous in
 * Node, so the refusal it just printed can be truncated. Flush, then exit.
 */
async function exitWith(code: number): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
  process.exit(code);
}

/** Greedy word wrap — findings messages are sentences, and a sentence that runs
 * off the right edge of a projector is a sentence nobody reads. */
function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  return out;
}

/** One line per finding, columns aligned, the check id first and loudest. A
 * message too long for the line wraps with a hanging indent to the message
 * column, so the grid survives and the ids stay scannable down the left edge. */
function printFindings(findings: Finding[]): void {
  if (findings.length === 0) return;
  const idW = Math.max(11, ...findings.map((f) => f.id.length + 2));
  const sevW = 10;
  const pathW = Math.min(38, Math.max(14, ...findings.map((f) => f.path.length + 2)));
  const gutter = 2 + idW + sevW + pathW;
  const width = Math.max(60, Math.min(process.stdout.columns ?? 110, 130));
  console.log(
    `  ${"CHECK".padEnd(idW)}${"SEVERITY".padEnd(sevW)}${"PATH".padEnd(pathW)}WHAT IS WRONG`,
  );
  for (const f of findings) {
    const head = `  ${f.id.padEnd(idW)}${(f.severity === "error" ? "ERROR" : "warn").padEnd(sevW)}${f.path.padEnd(pathW)}`;
    const lines = wrapWords(f.message, Math.max(28, width - gutter));
    console.log(`${head}${lines[0] ?? ""}`);
    for (const l of lines.slice(1)) console.log(`${" ".repeat(gutter)}${l}`);
  }
}

reqs
  .command("check <file>")
  .description("Run the gate over a reqs.json — exits 1 when the artefact is refused")
  .option("--mode <mode>", "exit (the gate) | lint (GATE family downgraded to warnings)", "exit")
  .option("--json", "print the whole analyser result as JSON instead")
  .action(async (file: string, opts) => {
    if (opts.mode !== "exit" && opts.mode !== "lint") {
      console.log(`--mode must be exit or lint (got '${opts.mode}')`);
      process.exit(1);
    }
    const { analyse } = await import("./reqs/analyse.js");
    const { loadRawReqs } = await import("./reqs/io.js");
    // Read BEFORE opening a connection: a typo in the path should not cost a
    // database round trip, and the error should arrive first.
    let raw: unknown;
    try {
      raw = await loadRawReqs(file);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { client, resolveOpt } = await openReqsCatalog();
    let refused = false;
    try {
      const result = await analyse(raw, { mode: opts.mode, ...resolveOpt });
      refused = !result.ok;
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const errors = result.findings.filter((f) => f.severity === "error");
        const warnings = result.findings.length - errors.length;
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
        printFindings(result.findings);
        const named = [...new Set(errors.map((f) => f.id))].join(", ");
        console.log(
          `\n  ${plural(result.checksRun, "check")} run   ${plural(errors.length, "error")}   ` +
            `${plural(warnings, "warning")}   ${result.ok ? "PASSED" : `REFUSED by ${named}`}`,
        );
      }
    } finally {
      if (client) await client.end();
    }
    // After the connection is closed, so the exit code cannot be clobbered.
    if (refused) await exitWith(1);
  });

const DELIVERY_KINDS = ["ui", "backend", "migration", "mixed"] as const;
const DELIVERY_TECH = ["new", "legacy"] as const;

reqs
  .command("elaborate <work-item>")
  .description("Elaborate a work item into a reqs.json — the artefact is written even when refused")
  .option("--out <path>", "output file (default: <work-item>.reqs.json)")
  .option("--kind <kind>", `delivery kind: ${DELIVERY_KINDS.join(" | ")}`, "backend")
  .option("--tech <tech>", `delivery technology: ${DELIVERY_TECH.join(" | ")}`, "legacy")
  .option("--ask <name>", "the human named on every escalated clarification")
  .option(
    "--record <path>",
    "write a replay pack of this run (prompt hash, reply, measured latency) — " +
      "replay it later with EIL_LLM_FIXTURE=<path>",
  )
  .option("--record-note <text>", "free text stored in the recorded pack's provenance block")
  .action(async (workItem: string, opts) => {
    // Declared facts about the delivery, not model judgments — so they are
    // options with defaults rather than another thing to ask a model.
    if (!(DELIVERY_KINDS as readonly string[]).includes(opts.kind)) {
      console.log(`--kind must be one of ${DELIVERY_KINDS.join(", ")} (got '${opts.kind}')`);
      process.exit(1);
    }
    if (!(DELIVERY_TECH as readonly string[]).includes(opts.tech)) {
      console.log(`--tech must be one of ${DELIVERY_TECH.join(", ")} (got '${opts.tech}')`);
      process.exit(1);
    }
    const { elaborate } = await import("./reqs/elaborate.js");
    const { localViewer } = await import("./search.js");
    const { makeDocResolver } = await import("./reqs/io.js");
    const out: string = opts.out ?? `${workItem}.reqs.json`;
    // Unlike `check` and `render`, this command CANNOT degrade to no catalog:
    // with no knowledge plane every unknown escalates and the run says nothing.
    const client = await connect();
    try {
      const viewer = localViewer();
      const body = await elaborate(workItem, {
        client,
        viewer,
        out,
        // The same resolver the gate uses, so a citation this run recorded is
        // verified against exactly the document the gate will re-read.
        resolveDoc: makeDocResolver(client, viewer),
        deliveryType: {
          kind: opts.kind as (typeof DELIVERY_KINDS)[number],
          tech: opts.tech as (typeof DELIVERY_TECH)[number],
        },
        ...(opts.ask ? { escalateTo: opts.ask } : {}),
        ...(opts.record ? { record: opts.record } : {}),
        ...(opts.recordNote ? { recordNote: opts.recordNote } : {}),
      });
      const findings = body.analysis?.findings ?? [];
      const errors = findings.filter((f) => f.severity === "error");
      const cov = body.coverage;
      console.log(`wrote ${out}`);
      // Said on every run, not only on a replay: "which of these two was this?"
      // must never be a question the operator has to work out afterwards.
      const { judgmentsLine } = await import("./reqs/render.js");
      console.log(`  judgments: ${judgmentsLine(body.metadata.generator)}`);
      if (opts.record) console.log(`  recorded the run to ${opts.record}`);
      if (cov)
        console.log(
          `  ${cov.leaves} leaves · ${cov.acs} ACs · ${cov.grounded} grounded · ` +
            `${cov.escalated} escalated · corpus ${body.metadata.corpusMode}\n`,
        );
      printFindings(findings);
      const named = [...new Set(errors.map((f) => f.id))].join(", ");
      // The artefact was produced, so this exits 0. The GATE is `eil reqs
      // check`, which exits 1 — a generator that refuses to emit its own output
      // would defeat the one property this command exists to hold.
      console.log(
        `\n  ${body.analysis?.checksRun ?? 0} checks run   ${errors.length} errors   ` +
          `${findings.length - errors.length} warnings   ` +
          `${errors.length === 0 ? "PASSED" : `REFUSED by ${named}`}`,
      );
      if (errors.length > 0) console.log("  run `eil reqs check` for the gate's exit code");
    } finally {
      await client.end();
    }
  });

reqs
  .command("render <file>")
  .description("Project a reqs.json as a self-contained HTML page (or markdown)")
  .option("--out <path>", "output file (default: the input path with .html)")
  .option("--markdown", "render markdown instead of HTML")
  .action(async (file: string, opts) => {
    const { analyse } = await import("./reqs/analyse.js");
    const { loadReqs } = await import("./reqs/io.js");
    const { renderHtml, renderMarkdown } = await import("./reqs/render.js");
    let body: ReqsBody;
    try {
      body = await loadReqs(file);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { client, resolveOpt } = await openReqsCatalog();
    try {
      // The gate runs FIRST and its findings go into the page: a refused
      // artefact must project as refused, not as a clean document.
      const result = await analyse(body, resolveOpt);
      const ext = opts.markdown ? ".md" : ".html";
      const out: string = opts.out ?? `${file.replace(/\.[^./\\]+$/, "")}${ext}`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        opts.markdown ? renderMarkdown(body, result.findings) : renderHtml(body, result.findings),
      );
      const errors = result.findings.filter((f) => f.severity === "error");
      console.log(`wrote ${out}`);
      if (errors.length > 0) {
        const named = [...new Set(errors.map((f) => f.id))].join(", ");
        // Both projections carry the stamp: the file itself has to be the record,
        // because the console line does not travel with it.
        console.log(`  stamped REFUSED by ${named}`);
      }
    } finally {
      if (client) await client.end();
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

program
  .command("doctor")
  .description(
    "Preflight: Node version, proxy/TLS route, database reachability, connector credentials and keychain",
  )
  .action(async () => {
    const { runDoctor } = await import("./doctor.js");
    const { closeScopedFetch } = await import("./connectors/httpclient.js");
    try {
      const report = await runDoctor();
      console.log(JSON.stringify(report, null, 2));
      // exitCode, not exit(2): the immediate form would tear the process
      // down before the finally below (and this command's own DB
      // connection close inside runDoctor) can finish running.
      if (!report.ok) process.exitCode = 2;
    } finally {
      await closeScopedFetch();
    }
  });

/**
 * F5b: the durable-queue worker pool and the schedule commands that feed it
 * are an explicit, opt-in Postgres deployment mode — `eil ingest ...` above
 * remains the synchronous path and works against local/PGlite exactly as
 * before. Queued execution needs real Postgres for FOR UPDATE SKIP LOCKED
 * across processes, so both command groups refuse a pglite:// DSN up
 * front rather than failing confusingly on the first claim() call.
 */
function requireRealPostgresForQueue(): void {
  if (dsn().startsWith("pglite://")) {
    console.log(
      "this command requires real Postgres (FOR UPDATE SKIP LOCKED across processes) — " +
        "EIL_DATABASE_URL is pglite://, which is the local/zero-install tier, not a queued deployment.",
    );
    process.exit(1);
  }
}

const worker = program
  .command("worker")
  .description("Durable-queue worker pool (F5b) — explicit Postgres deployment mode");

worker
  .command("run")
  .description("Claim and process queued connector-sync jobs until stopped (Ctrl+C)")
  .option("--concurrency <n>", "concurrent claim loops", "4")
  .option("--lease-ms <ms>", "lease duration per claim", "60000")
  .option("--poll-ms <ms>", "poll interval when the queue is empty", "1000")
  .action(async (opts) => {
    requireRealPostgresForQueue();
    const { registerIngestJobTypes, startWorkerPool } = await import("./worker.js");
    const { scrubJobError } = await import("./jobqueue.js");
    const { ConfluenceClient } = await import("./connectors/confluence.js");
    const { JiraClient } = await import("./connectors/jira.js");
    registerIngestJobTypes();
    const client = await connect();
    const reportError = (label: string, err: unknown) =>
      console.error(`${label}: ${scrubJobError(String((err as Error)?.message ?? err))}`);
    // Constructed lazily, per claimed job, NOT via liveClient()'s
    // hard-exit-on-missing-env behavior — a single job type's missing
    // credentials must fail (and retry/dead-letter) that one job through
    // the normal fail() path, not take down every other job the pool is
    // processing.
    const pool = startWorkerPool(client, {
      concurrency: Number(opts.concurrency),
      leaseMs: Number(opts.leaseMs),
      pollIntervalMs: Number(opts.pollMs),
      clients: {
        confluence: () => new ConfluenceClient(),
        jira: () => new JiraClient(),
      },
      // Without these, a database outage makes every claim loop retry
      // silently while this command keeps printing "running" — scrubbed
      // the same way a persisted job error is, since these can carry
      // upstream connector error text too.
      onClaimError: (err) => reportError("claim error", err),
      onJobError: (job, err) => reportError(`job ${job.id} (${job.job_type}) failed`, err),
    });
    console.log(`worker pool running (concurrency ${opts.concurrency}); press Ctrl+C to stop`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      console.log("stopping: finishing in-flight jobs...");
      await pool.stop();
      // ConfluenceClient/JiraClient route through the F2 scoped dispatcher;
      // leaving it open on shutdown leaks pooled sockets the same way an
      // un-closed doctor run would (see the doctor command above).
      const { closeScopedFetch } = await import("./connectors/httpclient.js");
      await closeScopedFetch();
      await client.end();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {}); // foreground until signalled
  });

const schedule = program
  .command("schedule")
  .description(
    "Enqueue a recurring connector sync onto the durable queue (F5b, requires real Postgres)",
  );

schedule
  .command("confluence")
  .description("Schedule a Confluence sync — full instance, space, project, or raw query")
  .option("--space <keys>", "one or more space keys, comma-separated")
  .option("--query <cql>", "raw CQL predicate (advanced escape hatch)")
  .option("--tenant <tenant>", "tenant", "default")
  .option("--window-ms <ms>", "dedupe window for repeated schedule calls", String(60 * 60 * 1000))
  .action(async (opts) => {
    requireRealPostgresForQueue();
    const { parseConfluenceScopes } = await import("./connectors/scope.js");
    let scopes: import("./connectors/scope.js").Scope[];
    try {
      scopes = parseConfluenceScopes(opts);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { registerIngestJobTypes, scheduleConfluenceSync } = await import("./worker.js");
    registerIngestJobTypes();
    const client = await connect();
    try {
      for (const scope of scopes) {
        const job = await scheduleConfluenceSync(client, opts.tenant, scope, {
          windowMs: Number(opts.windowMs),
        });
        console.log(
          `scheduled job ${job.id} (${job.status}) idempotency_key=${job.idempotency_key}`,
        );
      }
    } finally {
      await client.end();
    }
  });

schedule
  .command("jira")
  .description("Schedule a Jira sync — full instance, project, or raw query")
  .option("--project <keys>", "one or more project keys, comma-separated")
  .option("--query <jql>", "raw JQL predicate (advanced escape hatch)")
  .option("--tenant <tenant>", "tenant", "default")
  .option("--window-ms <ms>", "dedupe window for repeated schedule calls", String(60 * 60 * 1000))
  .action(async (opts) => {
    requireRealPostgresForQueue();
    const { parseJiraScopes } = await import("./connectors/scope.js");
    let scopes: import("./connectors/scope.js").Scope[];
    try {
      scopes = parseJiraScopes(opts);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { registerIngestJobTypes, scheduleJiraSync } = await import("./worker.js");
    registerIngestJobTypes();
    const client = await connect();
    try {
      for (const scope of scopes) {
        const job = await scheduleJiraSync(client, opts.tenant, scope, {
          windowMs: Number(opts.windowMs),
        });
        console.log(
          `scheduled job ${job.id} (${job.status}) idempotency_key=${job.idempotency_key}`,
        );
      }
    } finally {
      await client.end();
    }
  });

schedule
  .command("obsidian")
  .description("Schedule an Obsidian vault sync")
  .requiredOption("--vault <dir>", "Vault root directory")
  .option("--acl-group <g...>", "groups granted read; omit for owner-only (fail-closed)")
  .option("--follow-symlinks", "follow symlinks that stay inside --vault (default: skip them)")
  .option("--tenant <tenant>", "tenant", "default")
  .option("--window-ms <ms>", "dedupe window for repeated schedule calls", String(60 * 60 * 1000))
  .action(async (opts) => {
    requireRealPostgresForQueue();
    const { registerIngestJobTypes, scheduleObsidianSync } = await import("./worker.js");
    registerIngestJobTypes();
    const client = await connect();
    try {
      const job = await scheduleObsidianSync(client, opts.tenant, opts.vault, {
        windowMs: Number(opts.windowMs),
      });
      console.log(`scheduled job ${job.id} (${job.status}) idempotency_key=${job.idempotency_key}`);
    } finally {
      await client.end();
    }
  });

schedule
  .command("repo <ref>")
  .description("Schedule a git/Bitbucket repo sync")
  .option("--source <kind>", "git | bitbucket (default: auto-detect)")
  .option("--branch <b>", "branch", "main")
  .option("--subpath <p>", "restrict to a subdirectory")
  .option("--include <glob...>", "only paths matching (repeatable)")
  .option("--exclude <glob...>", "skip paths matching (repeatable)")
  .option("--name <key>", "override the repo key (else derived from the ref)")
  .option(
    "--acl-group <g...>",
    "groups granted read on this repo; omit for owner-only (fail-closed)",
  )
  .option("--tenant <tenant>", "tenant", "default")
  .option("--window-ms <ms>", "dedupe window for repeated schedule calls", String(60 * 60 * 1000))
  .action(async (ref: string, opts) => {
    requireRealPostgresForQueue();
    const { registerIngestJobTypes, scheduleRepoSync } = await import("./worker.js");
    registerIngestJobTypes();
    const client = await connect();
    try {
      const job = await scheduleRepoSync(
        client,
        opts.tenant,
        {
          ref,
          ...(opts.source ? { kind: opts.source } : {}),
          branch: opts.branch,
          ...(opts.subpath ? { subpath: opts.subpath } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.aclGroup ? { aclGroups: opts.aclGroup } : {}),
          ...(opts.include ? { includes: opts.include } : {}),
          ...(opts.exclude ? { excludes: opts.exclude } : {}),
        },
        { windowMs: Number(opts.windowMs) },
      );
      console.log(`scheduled job ${job.id} (${job.status}) idempotency_key=${job.idempotency_key}`);
    } finally {
      await client.end();
    }
  });

/**
 * The one place a failed command becomes something a person can act on.
 *
 * CatalogNotReady already carries a finished message, so it prints as-is with
 * no stack. Postgres's undefined_table / undefined_column / unknown-database
 * and a refused connection get the same treatment plus the database they were
 * talking to: on this CLI those nearly always mean "pointed at the wrong
 * catalog", and a driver stack trace sends people hunting a bug that is not
 * there. Everything else re-throws untouched — hiding real stacks would cost
 * more than it saves.
 */
program.parseAsync(process.argv).catch(async (err: any) => {
  const { CatalogNotReady, safeDsn } = await import("./db.js");
  if (err instanceof CatalogNotReady) {
    console.error(`\n${err.message}\n`);
    process.exit(2);
  }
  if (["42P01", "42703", "3D000", "ECONNREFUSED"].includes(err?.code)) {
    console.error(
      [
        "",
        String(err.message),
        "",
        `  database   ${safeDsn()}`,
        process.env.EIL_DATABASE_URL
          ? "             (from EIL_DATABASE_URL)"
          : "             (the default — EIL_DATABASE_URL is not set in this shell)",
        "",
        "  That usually means this command is pointed at the wrong catalog.",
        "  For the demo:  export EIL_DATABASE_URL=pglite://.eil-demo",
        "  To create it:  eil db migrate",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
  throw err;
});
