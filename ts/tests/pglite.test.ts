/**
 * Zero-install backend proof: the full pipeline — migrations (schemas,
 * generated tsvector columns, FK cascade), ingest with the hash gate, FTS
 * search with ranking, entity route, link graph, and the jsonb ACL
 * predicate — running on PGlite (WASM Postgres) with no server installed.
 * This is the work-machine no-admin path; if this suite passes, "can't
 * install Postgres" is not a blocker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, connect, migrate } from "../db.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { normalize as normalizeIssue } from "../ingest/jira.js";
import { type Viewer, getDoc, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { callTool } from "../tools.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));

const ME = userInfo().username;
const VIEWER: Viewer = viewerFromAuthenticatedClaims({
  principal: ME,
  groups: [],
  tenant: "default",
});

let dataDir: string;
let client: Db;
let savedUrl: string | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "eil-pglite-"));
  savedUrl = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
  client = await connect();
  await migrate(client);
  await upsertDocument(client, normalizePage(fixture("confluence_page.json")));
  await upsertDocument(client, normalizeIssue(fixture("jira_issue.json")));
});

afterAll(async () => {
  await client.end();
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("pglite zero-install backend", () => {
  it("applies every migration (schemas, generated columns, views, FKs)", async () => {
    const res = await client.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(res.rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it("hash gate: re-ingest is a no-op", async () => {
    expect(await upsertDocument(client, normalizePage(fixture("confluence_page.json")))).toBe(
      false,
    );
  });

  it("FTS docs route with ranking and snippet", async () => {
    const result: any = await searchDocs(client, VIEWER, "how do payment retries work");
    expect(result.route).toBe("docs");
    expect(result.results[0].id).toBe("confluence:page:12345");
    expect(result.results[0].snippet).toContain("**");
    expect(typeof result.results[0].score).toBe("number");
  });

  it("entity route with link graph", async () => {
    const result: any = await searchDocs(client, VIEWER, "PAY-981");
    expect(result.entity.id).toBe("jira:issue:PAY-981");
    const linked = result.linked.map((e: any) => e.id);
    expect(linked).toContain("confluence:page:12345");
    expect(linked).toContain("jira:issue:PAY-990"); // dangling edge survives
  });

  it("jsonb ACL predicate fail-closes for strangers", async () => {
    const stranger: Viewer = {
      principal: "someone-else",
      groups: ["grp-payments"],
      tenant: "default",
    };
    expect(await getDoc(client, stranger, "confluence:page:12345")).toBeNull();
    const insider: Viewer = {
      principal: "someone-else",
      groups: ["grp-payments-eng"],
      tenant: "default",
    };
    expect(await getDoc(client, insider, "confluence:page:12345")).not.toBeNull();
  });

  it("metrics views answer over pglite", async () => {
    await callTool("search_docs", { query: "payment retries" }, VIEWER, client);
    const res = await client.query("SELECT sum(calls)::int AS n FROM metrics.vw_tool_calls");
    expect(res.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("a SECOND PROCESS opening the same data dir is refused (pidfile lock)", () => {
    // In-process reconnects are reentrant by design; the lock guards across
    // processes — so spawn a real one and expect the clear refusal.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let output = "";
    try {
      output = execFileSync("pnpm", ["-s", "eil", "search", "x"], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { ...process.env, EIL_DATABASE_URL: `pglite://${dataDir}` },
        timeout: 30_000,
      });
    } catch (err: any) {
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(output).toContain("in use by pid");
  });

  it("reconcile tombstones docs deleted at the source", async () => {
    const { reconcile } = await import("../store.js");
    const doomed = normalizePage({ ...fixture("confluence_page.json"), id: "99999" });
    await upsertDocument(client, doomed);
    expect(await getDoc(client, VIEWER, "confluence:page:99999")).not.toBeNull();
    // full listing that no longer contains 99999
    const removed = await reconcile(client, "confluence", ["confluence:page:12345"]);
    expect(removed).toEqual(["confluence:page:99999"]);
    expect(await getDoc(client, VIEWER, "confluence:page:99999")).toBeNull();
    const orphanLinks = await client.query(
      "SELECT count(*)::int AS n FROM links WHERE src_id = 'confluence:page:99999'",
    );
    expect(orphanLinks.rows[0].n).toBe(0); // cascade followed
  });

  it("integrity audit passes on a healthy catalog and flags planted damage", async () => {
    const { integrity } = await import("../quality.js");
    const healthy = await integrity(client);
    expect(healthy.ok).toBe(true);
    expect(healthy.docs_without_chunks).toBe(0);
    expect(healthy.chunks_null_tsv).toBe(0);
    expect(healthy.links_dangling_dst).toBeGreaterThanOrEqual(1); // PAY-990 marker, by design

    // plant damage: a doc with no chunks and no owner
    await client.query(
      "INSERT INTO documents (id, source, title, content_hash, body, ingested_by)" +
        " VALUES ('confluence:page:broken', 'confluence', 'Broken', 'x', 'tiny', '')",
    );
    const damaged = await integrity(client);
    expect(damaged.ok).toBe(false);
    expect(damaged.docs_without_chunks).toBe(1);
    expect(damaged.docs_unowned).toBe(1);
    expect(damaged.docs_empty_body).toBeGreaterThanOrEqual(1);
    await client.query("DELETE FROM documents WHERE id = 'confluence:page:broken'");
    expect((await integrity(client)).ok).toBe(true);
  });

  it("drift sampling skips cleanly when source env is absent", async () => {
    const { drift } = await import("../quality.js");
    delete process.env.EIL_CONFLUENCE_URL;
    delete process.env.EIL_JIRA_URL;
    const report = await drift(client, 5);
    expect(report.sampled).toBe(0);
    expect(report.drifted).toEqual([]);
    expect(report.skipped.length).toBeGreaterThanOrEqual(2); // both fixture docs skipped
  });

  it("tenant-scoped viewer sees only its own tenant", async () => {
    const other = normalizePage({ ...fixture("confluence_page.json"), id: "55555" }, "team-b");
    await upsertDocument(client, other);
    const scoped: Viewer = { principal: ME, groups: [], tenant: "default" };
    expect(await getDoc(client, scoped, "confluence:page:55555")).toBeNull();
    const scopedB: Viewer = { principal: ME, groups: [], tenant: "team-b" };
    expect(await getDoc(client, scopedB, "confluence:page:55555")).not.toBeNull();
    expect(await getDoc(client, VIEWER, "confluence:page:55555")).toBeNull();
    await client.query(
      "DELETE FROM documents WHERE tenant = 'team-b' AND id = 'confluence:page:55555'",
    );
  });
});
