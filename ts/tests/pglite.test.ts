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

  // Regression: migration 0010 backfilled acl_version with md5(acl_groups::text)
  // while upsertInTx computes sha256(JSON.stringify(aclGroups)). 32 hex chars vs
  // 64, and jsonb::text renders ["a", "b"] with a space. The two could never be
  // equal, so every pre-existing document failed the hash gate forever — and the
  // chunk re-insert omits the embedding column, so the first post-deploy ingest
  // silently wiped the whole vector index.
  // Runs the REAL statement out of the migration file against a row that looks
  // like it predates 0010, which is the only situation where the backfill runs.
  // Asserting an inline copy of the SQL, or testing on a fresh DB where the app
  // writes acl_version itself, both pass while the migration is broken.
  it("migration 0010's acl_version backfill keeps the hash gate closed", async () => {
    const sql = readFileSync(
      new URL("../../migrations/0010_authorised_refresh_reconciliation.sql", import.meta.url),
      "utf-8",
    );
    const backfill = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--")) // statements are preceded by comment blocks
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("UPDATE documents") && s.includes("acl_version ="));
    expect(backfill).toBeTruthy();

    const doc = normalizePage({ ...fixture("confluence_page.json"), id: "77001" });
    expect(await upsertDocument(client, doc)).toBe(true);
    await client.query(
      "UPDATE chunks SET embedding = '{0.1,0.2}'::float4[], embed_model = 'test' WHERE doc_id = $1",
      ["confluence:page:77001"],
    );
    // rewind this row to its pre-0010 shape, then let the migration backfill it
    await client.query("UPDATE documents SET acl_version = '' WHERE id = $1", [
      "confluence:page:77001",
    ]);
    await client.query(backfill as string);

    // an unchanged re-ingest must be a no-op: no catalog churn, no vector loss
    expect(await upsertDocument(client, doc)).toBe(false);
    const kept = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1 AND embedding IS NOT NULL",
      ["confluence:page:77001"],
    );
    expect(kept.rows[0].n).toBeGreaterThan(0);
  });

  // Regression: ON CONFLICT set ingested_by = EXCLUDED.ingested_by, so any later
  // writer re-owned the row. acl_groups is stamped empty by every connector, so
  // ingested_by is the only thing granting the original ingester access.
  it("does not transfer ownership on re-ingest", async () => {
    const doc = normalizePage({ ...fixture("confluence_page.json"), id: "77002" });
    await upsertDocument(client, doc);
    await client.query("UPDATE documents SET ingested_by = 'alice' WHERE id = $1", [
      "confluence:page:77002",
    ]);
    await upsertDocument(client, { ...doc, body: `${doc.body}\n\nedited` });
    const owner = await client.query("SELECT ingested_by FROM documents WHERE id = $1", [
      "confluence:page:77002",
    ]);
    expect(owner.rows[0].ingested_by).toBe("alice");
  });

  // Regression: `complete` only asserts the connector thought it finished. A
  // truncated listing, a permissions change, or an unmounted vault all present
  // as a valid short "complete" listing and quarantined the entire corpus.
  it("refuses a reconcile that would quarantine most of a source", async () => {
    for (const id of ["77010", "77011", "77012", "77013"]) {
      await upsertDocument(client, normalizePage({ ...fixture("confluence_page.json"), id }));
    }
    await expect(reconcile(client, "confluence", { ids: [], complete: true })).rejects.toThrow(
      /reconcile refused/,
    );
    const live = await client.query(
      "SELECT count(*)::int AS n FROM documents WHERE source = 'confluence' AND tombstoned_at IS NULL",
    );
    expect(live.rows[0].n).toBeGreaterThan(0); // corpus intact
    const refusal = await client.query(
      "SELECT status FROM reconcile_runs ORDER BY id DESC LIMIT 1",
    );
    expect(refusal.rows[0].status).toBe("incomplete"); // and it is audited
  });

  // Regression: freshFetch ran BEFORE the ACL check, so any eil-refresh holder
  // could name an arbitrary id and have the server fetch it under its own PAT,
  // and the two distinct error strings formed an existence oracle.
  it("refuses to refresh a document the caller cannot read, without fetching", async () => {
    process.env.EIL_CONFLUENCE_URL = "http://127.0.0.1:9"; // would fail loudly if called
    const refresher = viewerFromAuthenticatedClaims({
      principal: "nobody",
      groups: ["eil-refresh"],
      tenant: "default",
    });
    const missing = await callTool(
      "refresh_doc",
      { id: "confluence:page:does-not-exist" },
      refresher,
      client,
    );
    const unreadable = await callTool(
      "refresh_doc",
      { id: "confluence:page:12345" },
      refresher,
      client,
    );
    expect((missing as any).error).toBe("not found: confluence:page:does-not-exist");
    expect((unreadable as any).error).toBe("not found: confluence:page:12345");
    delete process.env.EIL_CONFLUENCE_URL;
  });

  // Regression: two identical literals on one line collide on code_index's PK,
  // and an incompressible literal over ~2700 bytes blows the btree key limit.
  // Either aborted the whole repo ingest with the cursor unadvanced, so the
  // repo could never be ingested — 23.4% of this repo's own files trigger it.
  it("indexes a file with duplicate and oversized literals without failing", async () => {
    const blob = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251)).toString("base64");
    const body = `console.log("dup", "dup");\nconst DATA = "${blob}";\nexport function ok() {}`;
    const doc = normalizeCode("org/hard", "src/hard.ts", body, null, "default", "sha-hard");
    await upsertDocument(client, doc);
    await expect(
      replaceCodeIndex(client, doc, "org/hard", "src/hard.ts", "sha-hard"),
    ).resolves.toBeUndefined();
    const hit = await searchCodeIndex(client, VIEWER, { query: "ok", kind: "symbol" });
    expect(hit.results.length).toBeGreaterThan(0);
  });

  // Regression: the tombstone matched on repo alone while the listing was
  // subpath-restricted, so ingesting one subtree quarantined every other.
  it("a subpath resync does not quarantine the rest of the repo", async () => {
    const { reconcileCodeRepo } = await import("../store.js");
    for (const [path, dir] of [
      ["svcA/x.ts", "svcA"],
      ["svcA/y.ts", "svcA"],
      ["svcB/z.ts", "svcB"],
    ] as const) {
      const d = normalizeCode(
        "org/mono",
        path,
        `export function f_${dir}() {}`,
        null,
        "default",
        "sha-mono",
      );
      await upsertDocument(client, d);
    }
    // resync scoped to svcB: its listing mentions nothing under svcA
    await reconcileCodeRepo(client, "org/mono", ["code:org/mono:svcB/z.ts"], "default", "svcB");
    const live = await client.query(
      "SELECT code_path FROM documents WHERE code_repo = 'org/mono' AND tombstoned_at IS NULL ORDER BY code_path",
    );
    expect(live.rows.map((r: any) => r.code_path)).toEqual(["svcA/x.ts", "svcA/y.ts", "svcB/z.ts"]);
  });

  // The load-bearing claim of the secrets design: a quarantined document is
  // never chunked, so the secret cannot reach tsv (which is SEARCHABLE — a
  // matching fragment would confirm the key exists), ts_headline, the vector
  // snippet, or an embedding. Redacting only on serve would have left all four.
  it("a document with a secret is quarantined, unchunked and invisible", async () => {
    const doc = normalizePage({
      ...fixture("confluence_page.json"),
      id: "88001",
      body: "Deploy key: AKIAIOSFODNN7EXAMPLE for the payment job.",
    });
    await upsertDocument(client, doc);

    const row = await client.query(
      "SELECT quarantined_at, secret_findings, body FROM documents WHERE id = $1",
      ["confluence:page:88001"],
    );
    expect(row.rows[0].quarantined_at).not.toBeNull();
    expect(row.rows[0].secret_findings[0].rule).toBe("aws-access-key-id");
    expect(row.rows[0].body).toContain("AKIAIOSFODNN7EXAMPLE"); // retained for remediation

    // nothing downstream of chunking exists, so nothing downstream can leak
    const chunks = await client.query("SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1", [
      "confluence:page:88001",
    ]);
    expect(chunks.rows[0].n).toBe(0);

    // and the tsvector cannot be probed for the secret
    const probe = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE tsv @@ plainto_tsquery('english', $1)",
      ["AKIAIOSFODNN7EXAMPLE"],
    );
    expect(probe.rows[0].n).toBe(0);

    expect(await getDoc(client, VIEWER, "confluence:page:88001")).toBeNull();
    const found: any = await searchDocs(client, VIEWER, "payment job deploy key", 10);
    expect(found.results.map((r: any) => r.id)).not.toContain("confluence:page:88001");
  });

  it("surfaces quarantined documents as a remediation worklist", async () => {
    const { integrity } = await import("../quality.js");
    expect((await integrity(client)).docs_quarantined).toBeGreaterThan(0);
  });

  // Regression: upsert DELETEd every chunk and re-INSERTed without the embedding
  // column, so a one-character edit re-embedded the whole document. Pairs with
  // the metadata-aware contentHash, which changes every existing row's hash and
  // would otherwise discard the entire corpus's vectors on the next ingest.
  it("keeps embeddings for chunks whose text did not change", async () => {
    const base = normalizePage({ ...fixture("confluence_page.json"), id: "88002" });
    await upsertDocument(client, base);
    await client.query(
      "UPDATE chunks SET embedding = '{0.1,0.2}'::float4[], embed_model = 'test' WHERE doc_id = $1",
      ["confluence:page:88002"],
    );
    const before = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1 AND embedding IS NOT NULL",
      ["confluence:page:88002"],
    );
    expect(before.rows[0].n).toBeGreaterThan(1);

    // Change the URL — metadata that is NOT part of any chunk's text. The
    // document hash changes and the row is rewritten, but every chunk hashes
    // identically, so every vector survives.
    //
    // A TITLE change would legitimately invalidate all of them, because the
    // chunker prefixes `headingPath` (which begins with the title) into every
    // chunk's text. That coupling is exactly what §5's "store text clean"
    // change removes; until it lands, renaming a page is a full re-embed.
    await upsertDocument(client, { ...base, url: "https://confluence.corp/moved" });
    const after = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1 AND embedding IS NOT NULL",
      ["confluence:page:88002"],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  // The same change proves the metadata hash: a title-only edit must PROPAGATE.
  it("propagates a metadata-only change through the hash gate", async () => {
    const base = normalizePage({ ...fixture("confluence_page.json"), id: "88003" });
    await upsertDocument(client, base);
    expect(await upsertDocument(client, base)).toBe(false); // truly unchanged
    expect(await upsertDocument(client, { ...base, title: "Renamed" })).toBe(true);
    const t = await client.query("SELECT title FROM documents WHERE id = $1", [
      "confluence:page:88003",
    ]);
    expect(t.rows[0].title).toBe("Renamed");
    // and an ACL-group change, the one that actually matters
    expect(await upsertDocument(client, { ...base, title: "Renamed", aclGroups: ["ops"] })).toBe(
      true,
    );
  });

  // AC: "snippets contain no breadcrumb". Both snippet paths read chunks.text —
  // ts_headline() on the lexical arm and slice(0,240) on the vector arm — so the
  // old prefixed shape charged every snippet for the breadcrumb.
  it("returns snippets that start with content, not with the breadcrumb", async () => {
    const res: any = await searchDocs(client, VIEWER, "payment retries", 5);
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.snippet).not.toContain("Payment Retry Policy >");
      expect(r.snippet.replace(/\*\*/g, "").trim().startsWith("Payment Retry Policy")).toBe(false);
    }
  });

  // Removing the prefix from `text` would have silently dropped title and space
  // terms out of the lexical index, since the prefix was the only thing putting
  // them there. tsv is built over heading_path AND text, with the breadcrumb at
  // weight A so a title match now outranks a body match instead of tying it.
  it("keeps breadcrumb terms searchable, at a higher weight than body terms", async () => {
    const hit = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE tsv @@ plainto_tsquery('english', $1)",
      ["idempotency"], // appears only in a heading in the fixture
    );
    expect(hit.rows[0].n).toBeGreaterThan(0);
    const weights = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE tsv @@ to_tsquery('english', $1)",
      ["idempot:A"], // :A == matched at heading weight
    );
    expect(weights.rows[0].n).toBeGreaterThan(0);
  });

  // AC: "editing one chunk of a 100-chunk document re-embeds exactly one".
  it("re-embeds exactly the chunk that changed, and no others", async () => {
    const sections = Array.from(
      { length: 12 },
      (_, i) => `## Section ${i}\n\nBody text for section ${i} with enough words to chunk.`,
    );
    const base = normalizePage({
      ...fixture("confluence_page.json"),
      id: "88010",
      body: sections.join("\n\n"),
    });
    await upsertDocument(client, base);
    await client.query(
      "UPDATE chunks SET embedding = '{0.1,0.2}'::float4[], embed_model = 'test' WHERE doc_id = $1",
      ["confluence:page:88010"],
    );
    const total = await client.query("SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1", [
      "confluence:page:88010",
    ]);
    expect(total.rows[0].n).toBeGreaterThan(5);

    // change ONE section's body
    sections[7] = "## Section 7\n\nCompletely rewritten body for section seven now.";
    await upsertDocument(client, { ...base, body: sections.join("\n\n") });

    const cleared = await client.query(
      "SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1 AND embedding IS NULL",
      ["confluence:page:88010"],
    );
    expect(cleared.rows[0].n).toBe(1); // exactly one, not the whole document
  });

  // Regression from a real dry run: quarantined documents are DELIBERATELY
  // unchunked — that is the safety property — but integrity() counted them as
  // chunkless, so secret quarantine working correctly made `eil audit --strict`
  // exit non-zero. A working security feature must not fail the CI gate.
  it("does not report a quarantined document as an integrity fault", async () => {
    const { integrity } = await import("../quality.js");
    const doc = normalizePage({
      ...fixture("confluence_page.json"),
      id: "88020",
      body: "Deploy key AKIAIOSFODNN7EXAMPLE rotates monthly.",
    });
    await upsertDocument(client, doc);
    const report = await integrity(client);
    expect(report.docs_quarantined).toBeGreaterThan(0);
    expect(report.docs_without_chunks).toBe(0);
    expect(report.ok).toBe(true);
  });

  // Source code legitimately contains HTML strings; counting them as failed
  // markdown conversion is a false positive that trains people to ignore the
  // number.
  it("does not flag html inside source code as conversion residue", async () => {
    const { integrity } = await import("../quality.js");
    const { normalizeCode } = await import("../ingest/code.js");
    await upsertDocument(
      client,
      normalizeCode(
        "org/r",
        "src/render.ts",
        'const t = "<p>hello</p></div>";',
        null,
        "default",
        "sha",
      ),
    );
    expect((await integrity(client)).docs_html_residue).toBe(0);
  });
});
