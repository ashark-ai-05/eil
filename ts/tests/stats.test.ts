/**
 * BM25 corpus statistics. Schema + refresh only — no query scores with these
 * yet, because changing how results are RANKED needs the eval gate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { discriminativeTerms, refreshStats } from "../core/stats.js";
import { type Db, connect, migrate } from "../db.js";
import { upsertDocument } from "../store.js";

let client: Db;
let dir: string;
let saved: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eil-stats-"));
  saved = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  client = await connect();
  await migrate(client);
  // "work" appears everywhere; "idempotency" in one document. That contrast is
  // the entire point of IDF, and ts_rank cannot see it.
  for (let i = 0; i < 20; i++) {
    await upsertDocument(
      client,
      CanonicalDoc.parse({
        id: `confluence:page:st-${i}`,
        source: "confluence",
        title: `Doc ${i}`,
        body: `This describes how the work is scheduled and how the work proceeds. Variant ${i}.`,
        aclGroups: [],
      }),
    );
  }
  await upsertDocument(
    client,
    CanonicalDoc.parse({
      id: "confluence:page:st-rare",
      source: "confluence",
      title: "Idempotency",
      body: "Idempotency keys make the work safe to retry without duplicate charges.",
      aclGroups: [],
    }),
  );
});
afterAll(async () => {
  await client.end();
  if (saved === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("refreshStats", () => {
  it("derives df, N and avgdl from the tsvector Postgres already maintains", async () => {
    const s = await refreshStats(client);
    expect(s.lexemes).toBeGreaterThan(0);
    expect(s.nChunks).toBe(21);
    expect(s.avgLen).toBeGreaterThan(0);
    const len = await client.query("SELECT count(*)::int AS n FROM chunks WHERE len IS NULL");
    expect(len.rows[0].n).toBe(0);
  });

  it("records the frequency contrast that ts_rank is blind to", async () => {
    const rows = await client.query(
      "SELECT lexeme, df FROM lexeme_stats WHERE lexeme IN ('work', 'idempot') ORDER BY df DESC",
    );
    const df = new Map(rows.rows.map((r: any) => [r.lexeme, Number(r.df)]));
    expect(df.get("work")).toBeGreaterThan(df.get("idempot")!);
  });

  it("is idempotent and never leaves the table empty mid-refresh", async () => {
    const a = await refreshStats(client);
    const b = await refreshStats(client);
    expect(b).toEqual(a);
    const exists = await client.query("SELECT count(*)::int AS n FROM lexeme_stats");
    expect(exists.rows[0].n).toBe(a.lexemes);
  });
});

describe("discriminativeTerms", () => {
  it("drops the common term and keeps the rare one", async () => {
    const terms = await discriminativeTerms(client, "how does the idempotency work");
    const lex = terms.map((t) => t.lexeme);
    expect(lex).toContain("idempot");
    expect(lex).not.toContain("work"); // in >15% of the corpus
  });

  it("returns the rarest terms rather than nothing when everything is common", async () => {
    // Returning [] would turn a broad query into a zero-result one — the exact
    // failure the loose-OR fallback exists to prevent.
    const terms = await discriminativeTerms(client, "the work is scheduled");
    expect(terms.length).toBeGreaterThan(0);
  });

  it("orders rarest first, so a scan can stop early", async () => {
    const terms = await discriminativeTerms(client, "idempotency work scheduled", 1.0);
    const dfs = terms.map((t) => t.df);
    expect([...dfs].sort((a, b) => a - b)).toEqual(dfs);
  });
});
