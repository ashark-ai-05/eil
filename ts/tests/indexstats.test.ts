/**
 * The index, reported honestly.
 *
 * This is shown on stage to back a specific claim — that the semantic arm runs
 * on core Postgres with no extension installed. Two ways that could become a
 * lie without anyone noticing: the extension list could stop being read from
 * pg_extension, or the scoring SQL quoted here could drift away from the query
 * that actually runs. Both are guarded below.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import {
  CatalogNotReady,
  type Db,
  assertCatalogReady,
  connect,
  migrate,
  pendingMigrations,
  safeDsn,
} from "../db.js";
import { FakeEmbedder } from "../embed/index.js";
import { SCORING_SQL, formatIndexStats, indexStats } from "../indexstats.js";
import { upsertDocument } from "../store.js";

let dataDir: string;
let client: Db;
let savedUrl: string | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "eil-idxstats-"));
  savedUrl = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
  client = await connect();
  await migrate(client);

  await upsertDocument(
    client,
    CanonicalDoc.parse({
      id: "confluence:page:1",
      source: "confluence",
      title: "Runbook",
      body: "A short page about settlement.",
      aclGroups: [],
      links: [],
    }),
  );
  await upsertDocument(
    client,
    CanonicalDoc.parse({
      id: "code:repo:src/a.ts",
      source: "code",
      title: "src/a.ts",
      body: "export const a = 1;",
      aclGroups: [],
      links: [],
    }),
  );
});

afterAll(async () => {
  await client?.end();
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("index stats", () => {
  it("counts documents and chunks per source", async () => {
    const s = await indexStats(client);
    expect(s.documents).toBe(2);
    expect(s.chunks).toBeGreaterThan(0);
    expect(s.sources.map((r) => r.source).sort()).toEqual(["code", "confluence"]);
    expect(s.sources.every((r) => r.documents > 0)).toBe(true);
  });

  it("shows no extension installed, which is the whole claim", async () => {
    // Reading this from pg_extension rather than hardcoding an empty list is
    // the point: if someone later adds a dependency on pgvector, this report
    // has to say so rather than keep printing the reassuring answer.
    const s = await indexStats(client);
    expect(s.extensions).toEqual([]);
    expect(s.backend).toBe("pglite");
  });

  it("says plainly when nothing is embedded rather than implying a vector arm", async () => {
    const s = await indexStats(client);
    expect(s.embeddedChunks).toBe(0);
    expect(s.vectorDim).toBeNull();
    expect(s.embedModel).toBeNull();
  });

  // I2 regression (task-2 review): vectors moved off chunks.embedding onto
  // chunk_vectors (migration 0020), one row per embedder WINDOW. Reading the
  // dead column here made this report claim "the semantic arm is not
  // running" on a corpus where it demonstrably is — the first thing
  // demo/eil-README.md has a human type. embeddedChunks must count distinct
  // CHUNKS (tenant, doc_id, seq), not chunk_vectors rows, so a chunk split
  // into several windows doesn't inflate the count past `chunks` itself.
  it("reports the vector arm as running once chunk_vectors is populated", async () => {
    const emb = new FakeEmbedder(8);
    const { backfill } = await import("../embed/backfill.js");
    await backfill(client, emb, { reembed: true });
    const s = await indexStats(client);
    expect(s.embeddedChunks).toBeGreaterThan(0);
    expect(s.embeddedChunks).toBeLessThanOrEqual(s.chunks); // per-chunk, not per-window
    expect(s.vectorDim).toBe(8);
    expect(s.embedModel).toBe(emb.id);
    expect(formatIndexStats(s)).not.toContain("the semantic arm is not running");
    expect(formatIndexStats(s)).toContain(`model          ${emb.id}`);
  });

  it("quotes scoring SQL that the real search query still contains", async () => {
    // The drift guard. A slide can go stale silently; a test cannot.
    const searchSrc = readFileSync(
      join(fileURLToPath(new URL("../search.ts", import.meta.url))),
      "utf8",
    );
    const normalise = (sql: string) => sql.replace(/\s+/g, " ").trim();
    expect(normalise(searchSrc)).toContain(normalise(SCORING_SQL));
  });

  it("refuses a catalog that is behind, instead of failing on a missing column", async () => {
    // The real report: after the demo, a hand-typed command falls back to the
    // default DSN and lands on a stale database. The raw driver error
    // ("column c.tenant does not exist") reads like a bug in the command.
    const bare = mkdtempSync(join(tmpdir(), "eil-bare-"));
    const saved = process.env.EIL_DATABASE_URL;
    process.env.EIL_DATABASE_URL = `pglite://${bare}`;
    const empty = await connect();
    try {
      expect((await pendingMigrations(empty)).length).toBeGreaterThan(0);
      await expect(indexStats(empty)).rejects.toBeInstanceOf(CatalogNotReady);
      await expect(assertCatalogReady(empty)).rejects.toThrow(/No catalog here/);
    } finally {
      await empty.end();
      if (saved === undefined) delete process.env.EIL_DATABASE_URL;
      else process.env.EIL_DATABASE_URL = saved;
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("reports nothing pending once migrated", async () => {
    expect(await pendingMigrations(client)).toEqual([]);
  });

  it("never prints a password from the DSN", async () => {
    // These messages name the database, and a connection string is exactly the
    // kind of thing that ends up in a screenshot or a bug report.
    expect(safeDsn("postgresql://eil:hunter2@db.internal:5432/eil")).toBe(
      "postgresql://eil:***@db.internal:5432/eil",
    );
    expect(safeDsn("postgresql:///eil")).toBe("postgresql:///eil");
    expect(safeDsn("pglite://.eil-demo")).toBe("pglite://.eil-demo");
  });
});
