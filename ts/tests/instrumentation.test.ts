/**
 * Step 0 contract: the system can report on itself honestly.
 *
 * Every assertion here corresponds to a measured defect. Before this, audit()
 * ran AFTER the handler, so only successes were recorded — the error rate was
 * not merely unmeasured but unmeasurable; there was no duration column, so p95
 * was unobtainable; and `route`/`executor` were computed in searchDocs and
 * discarded, so arm contribution was invisible.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, connect, migrate } from "../db.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { type Viewer, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { REGISTRY, callTool } from "../tools.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));

const VIEWER: Viewer = viewerFromAuthenticatedClaims({
  principal: userInfo().username,
  groups: [],
  tenant: "default",
});

let client: Db;
let dataDir: string;
let savedUrl: string | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "eil-instr-"));
  savedUrl = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
  client = await connect();
  await migrate(client);
  await upsertDocument(client, normalizePage(fixture("confluence_page.json")));
});

afterAll(async () => {
  await client.end();
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

const lastAudit = async () =>
  (await client.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")).rows[0];

describe("step 0 — instrumentation", () => {
  it("records duration, outcome, route and executor on a successful call", async () => {
    const res: any = await callTool("search_docs", { query: "payment retries" }, VIEWER, client);
    const row = await lastAudit();
    expect(row.ok).toBe(true);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.route).toBe(res.route); // computed in searchDocs, no longer discarded
    expect(row.executor).toBe(res.executor);
    expect(row.trace_id).toBe(res.trace_id); // returned to the caller AND persisted
  });

  it("audits a handler that returns an error as ok=false", async () => {
    await callTool("get_doc", { id: "confluence:page:nope" }, VIEWER, client);
    const row = await lastAudit();
    expect(row.ok).toBe(false);
    expect(row.error).toContain("not found");
  });

  it("audits a handler that THROWS, and still propagates the throw", async () => {
    const spec = REGISTRY.search_docs!;
    const original = spec.handler;
    spec.handler = async () => {
      throw new Error("boom from handler");
    };
    try {
      await expect(callTool("search_docs", { query: "x" }, VIEWER, client)).rejects.toThrow(
        "boom from handler",
      );
    } finally {
      spec.handler = original;
    }
    const row = await lastAudit();
    expect(row.ok).toBe(false);
    expect(row.error).toContain("boom from handler");
  });

  it("makes p95 answerable in SQL", async () => {
    const res = await client.query(
      "SELECT tool, calls, failures, p95_ms FROM metrics.vw_tool_latency ORDER BY tool",
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.every((r: any) => typeof r.p95_ms === "number")).toBe(true);
    expect(res.rows.some((r: any) => r.failures > 0)).toBe(true); // failures are visible
  });

  it("records a retrieval_event linked to the audit row by trace_id", async () => {
    const res: any = await callTool("search_docs", { query: "payment retries" }, VIEWER, client);
    const ev = await client.query("SELECT * FROM retrieval_events WHERE trace_id = $1", [
      res.trace_id,
    ]);
    expect(ev.rows).toHaveLength(1);
    const returned = ev.rows[0].returned;
    expect(Array.isArray(returned)).toBe(true);
    expect(returned[0]).toHaveProperty("doc_id");
    expect(returned[0]).toHaveProperty("rank");
  });

  it("persists integrity so it can trend and alert", async () => {
    const { integrity, recordHealth } = await import("../quality.js");
    const report = await integrity(client);
    await recordHealth(client, "integrity", report.ok, report);
    const rows = await client.query(
      "SELECT kind, ok, report FROM metrics.health_runs WHERE kind = 'integrity'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].report).toHaveProperty("docs_total");
  });

  it("surfaces which arms actually ran", async () => {
    const res = await client.query("SELECT route, executor, calls FROM metrics.vw_arm_mix");
    expect(res.rows.length).toBeGreaterThan(0);
  });
});
