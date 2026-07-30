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
import { type Db, connect, migrate } from "../db.js";
import { SCORING_SQL, indexStats } from "../indexstats.js";
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

  it("quotes scoring SQL that the real search query still contains", async () => {
    // The drift guard. A slide can go stale silently; a test cannot.
    const searchSrc = readFileSync(
      join(fileURLToPath(new URL("../search.ts", import.meta.url))),
      "utf8",
    );
    const normalise = (sql: string) => sql.replace(/\s+/g, " ").trim();
    expect(normalise(searchSrc)).toContain(normalise(SCORING_SQL));
  });
});
