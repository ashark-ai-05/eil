/**
 * The harness end-to-end against a real database. Its two load-bearing
 * properties: it runs the PRODUCTION retriever rather than a reimplementation,
 * and the labelled set bootstraps by replaying real audit_log traffic instead of
 * asking someone to invent queries — which is why docs/golden-queries.md sat at
 * two entries for its lifetime.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, connect, migrate } from "../db.js";
import { compareRuns, mineQueries, runEval } from "../eval/harness.js";
import { pairedPermutationTest } from "../eval/metrics.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { type Viewer, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { callTool } from "../tools.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));

const VIEWER: Viewer = viewerFromAuthenticatedClaims({
  principal: userInfo().username,
  groups: [],
  tenant: "default",
});

let client: Db;
let dir: string;
let saved: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eil-eval-"));
  saved = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  client = await connect();
  await migrate(client);
  await upsertDocument(client, normalizePage(fixture("confluence_page.json")));
  for (const [id, title, body] of [
    ["70001", "Refund Policy", "Refunds are issued within five business days of approval."],
    ["70002", "Dunning Schedule", "Dunning emails are sent on days 1, 3 and 7 after failure."],
  ] as const) {
    await upsertDocument(
      client,
      normalizePage({ ...fixture("confluence_page.json"), id, title, body }),
    );
  }
});

afterAll(async () => {
  await client.end();
  if (saved === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("mining the labelled set from real traffic", () => {
  it("promotes distinct successful searches, and only those", async () => {
    await callTool("search_docs", { query: "how do payment retries work" }, VIEWER, client);
    await callTool("search_docs", { query: "how do payment retries work" }, VIEWER, client); // dup
    await callTool("search_docs", { query: "dunning schedule after failure" }, VIEWER, client);
    await callTool("search_docs", { query: "x" }, VIEWER, client); // too short
    await callTool("get_doc", { id: "confluence:page:nope" }, VIEWER, client); // failed, not a search

    const added = await mineQueries(client, { tenant: "default" });
    expect(added).toBe(2); // deduplicated, short one skipped, failure skipped

    const rows = await client.query("SELECT query, origin FROM eval_queries ORDER BY query");
    expect(rows.rows.map((r: any) => r.origin)).toEqual(["logged", "logged"]);
    expect(rows.rows.map((r: any) => r.query)).toEqual([
      "dunning schedule after failure",
      "how do payment retries work",
    ]);
  });

  it("is idempotent — re-mining adds nothing", async () => {
    expect(await mineQueries(client, { tenant: "default" })).toBe(0);
  });
});

describe("scoring through the production path", () => {
  it("runs unjudged queries but refuses to score them", async () => {
    const r = await runEval(client, VIEWER);
    expect(r.queries).toBe(2);
    expect(r.judged).toBe(0); // nothing judged yet
    expect(Number.isNaN(r.ndcg10)).toBe(true); // NOT 0 — absent, not bad
  });

  it("scores once judgments exist, and persists per-query results", async () => {
    const qs = await client.query("SELECT id, query FROM eval_queries ORDER BY query");
    const byQuery = new Map(qs.rows.map((r: any) => [r.query, Number(r.id)]));
    await client.query(
      "INSERT INTO eval_qrels (query_id, doc_id, grade, judged_by) VALUES ($1, $2, 3, 'test')",
      [byQuery.get("how do payment retries work"), "confluence:page:12345"],
    );
    await client.query(
      "INSERT INTO eval_qrels (query_id, doc_id, grade, judged_by) VALUES ($1, $2, 3, 'test')",
      [byQuery.get("dunning schedule after failure"), "confluence:page:70002"],
    );

    const r = await runEval(client, VIEWER, { persist: true, gitSha: "testsha" });
    expect(r.judged).toBe(2);
    expect(r.recall10).toBeGreaterThan(0);
    expect(r.runId).not.toBeNull();

    const stored = await client.query(
      "SELECT count(*)::int AS n FROM metrics.eval_query_results WHERE run_id = $1",
      [r.runId],
    );
    expect(stored.rows[0].n).toBe(2); // per-query, so a regression can be attributed
  });
});

describe("regression detection", () => {
  // The AC: "a deliberate ranking regression is detected at p < 0.05". Two
  // stored runs are compared PAIRWISE, which is where the statistical power at
  // n~150 comes from — comparing two means throws away that both systems
  // answered the same queries.
  it("detects a deliberate degradation and clears a no-op change", async () => {
    const base = Array.from({ length: 60 }, (_, i) => 0.7 + (i % 7) * 0.01);
    const degraded = base.map((x) => x - 0.09); // every query got worse
    const noop = [...base];

    const bad = pairedPermutationTest(base, degraded);
    expect(bad.meanDelta).toBeLessThan(0);
    expect(bad.p).toBeLessThan(0.05);

    const same = pairedPermutationTest(base, noop);
    expect(same.meanDelta).toBe(0);
    expect(same.p).toBeGreaterThan(0.05); // a no-op must NOT read as significant
  });

  it("pairs two stored runs by query id", async () => {
    const r2 = await runEval(client, VIEWER, { persist: true, gitSha: "testsha2" });
    const runs = await client.query("SELECT id FROM metrics.eval_runs ORDER BY id");
    const ids = runs.rows.map((r: any) => Number(r.id));
    const { a, b, queryIds } = await compareRuns(client, ids[0]!, ids[ids.length - 1]!);
    expect(queryIds.length).toBe(2);
    expect(a.length).toBe(b.length);
    // identical config -> identical scores, which is only assertable because
    // retrieval is deterministic
    expect(a).toEqual(b);
    expect(r2.runId).toBe(ids[ids.length - 1]);
  });

  it("rejects an unknown metric rather than interpolating it into SQL", async () => {
    await expect(compareRuns(client, 1, 2, "ndcg_10; DROP TABLE" as any)).rejects.toThrow(
      "unknown eval metric",
    );
  });
});
