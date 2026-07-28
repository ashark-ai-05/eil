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
import { searchCodeIndex } from "../code-search.js";
import { type Db, connect, migrate } from "../db.js";
import { normalizeCode } from "../ingest/code.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { normalize as normalizeIssue } from "../ingest/jira.js";
import { type Viewer, getDoc, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { reconcile, replaceCodeIndex, upsertDocument } from "../store.js";
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
    const removed = await reconcile(client, "confluence", {
      ids: ["confluence:page:12345"],
      complete: true,
    });
    expect(removed.tombstoned).toEqual(["confluence:page:99999"]);
    expect(await getDoc(client, VIEWER, "confluence:page:99999")).toBeNull();
    const orphanLinks = await client.query(
      "SELECT count(*)::int AS n FROM links WHERE src_id = 'confluence:page:99999'",
    );
    expect(orphanLinks.rows[0].n).toBe(2); // quarantine retains evidence for recovery
  });

  it("keeps reads pure and requires explicit refresh authorization", async () => {
    const read = await callTool(
      "get_doc",
      { id: "confluence:page:12345", fresh: true },
      VIEWER,
      client,
    );
    expect((read as any).error).toBe("invalid arguments for get_doc");
    const refresh = await callTool("refresh_doc", { id: "confluence:page:12345" }, VIEWER, client);
    expect((refresh as any).error).toBe("refresh_doc requires eil-refresh authorization");
  });

  it("records incomplete listings without tombstoning documents", async () => {
    const before = await client.query(
      "SELECT tombstoned_at FROM documents WHERE tenant = 'default' AND id = $1",
      ["confluence:page:12345"],
    );
    const outcome = await reconcile(client, "confluence", { ids: [], complete: false });
    const after = await client.query(
      "SELECT tombstoned_at FROM documents WHERE tenant = 'default' AND id = $1",
      ["confluence:page:12345"],
    );
    expect(outcome).toEqual({ status: "incomplete", tombstoned: [] });
    expect(after.rows[0].tombstoned_at).toEqual(before.rows[0].tombstoned_at);
  });

  it("retains ACL snapshot history for each changed revision", async () => {
    const first = await client.query(
      "SELECT revision, acl_snapshot FROM documents WHERE tenant = 'default' AND id = $1",
      ["confluence:page:12345"],
    );
    const changed = {
      ...normalizePage(fixture("confluence_page.json")),
      aclGroups: ["ops"],
      body: `${normalizePage(fixture("confluence_page.json")).body}\nchanged`,
    };
    await upsertDocument(client, changed);
    const revisions = await client.query(
      "SELECT revision, acl_snapshot FROM document_revisions WHERE tenant = 'default' AND doc_id = $1 ORDER BY revision",
      ["confluence:page:12345"],
    );
    expect(revisions.rows.length).toBeGreaterThanOrEqual(2);
    expect(revisions.rows.at(-1).acl_snapshot).toEqual(["ops"]);
    expect(revisions.rows.at(-1).revision).toBe(first.rows[0].revision + 1);
  });

  it("retrieves deterministic ACL-filtered code citations at an immutable ref", async () => {
    const doc = normalizeCode(
      "org/repo",
      "src/retry.ts",
      'export function retryPayment() { return "retry"; }',
      null,
      "default",
      "sha-code-1",
    );
    await upsertDocument(client, doc);
    await replaceCodeIndex(client, doc, "org/repo", "src/retry.ts", "sha-code-1");
    const hit = await searchCodeIndex(client, VIEWER, {
      query: "retrypayment",
      kind: "symbol",
      ref: "sha-code-1",
    });
    expect(hit.executor).toBe("code_index");
    expect(hit.results).toHaveLength(1);
    expect(hit.results[0]).toMatchObject({ path: "src/retry.ts", ref: "sha-code-1", lineStart: 1 });
    expect(hit.context.totalChars).toBeGreaterThan(0);
    const routed: any = await searchDocs(client, VIEWER, "retryPayment");
    expect(routed).toMatchObject({ route: "symbol", executor: "code_index" });
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
