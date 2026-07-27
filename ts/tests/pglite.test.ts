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
import { type Viewer, getDoc, searchDocs } from "../search.js";
import { upsertDocument } from "../store.js";
import { callTool } from "../tools.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));

const ME = userInfo().username;
const VIEWER: Viewer = { principal: ME, groups: [] };

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
    const stranger: Viewer = { principal: "someone-else", groups: ["grp-payments"] };
    expect(await getDoc(client, stranger, "confluence:page:12345")).toBeNull();
    const insider: Viewer = { principal: "someone-else", groups: ["grp-payments-eng"] };
    expect(await getDoc(client, insider, "confluence:page:12345")).not.toBeNull();
  });

  it("metrics views answer over pglite", async () => {
    await callTool("search_docs", { query: "payment retries" }, VIEWER, client);
    const res = await client.query("SELECT sum(calls)::int AS n FROM metrics.vw_tool_calls");
    expect(res.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
