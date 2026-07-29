/**
 * Step 3 items that are provable WITHOUT the labelled set: latency, a measured
 * truncation boundary, and additive response fields that change no ranking.
 *
 * The ranking-affecting items in step 3 (chunk size, dropping code overlap) are
 * deliberately NOT here. Their acceptance criterion is "kept only if nDCG@10
 * does not regress", and with an empty qrel set that cannot be honoured — so
 * they wait rather than shipping on a plausible argument.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, connect, migrate } from "../db.js";
import { cosine, getEmbedder, resetEmbedderCache } from "../embed/index.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { type Viewer, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
const VIEWER: Viewer = viewerFromAuthenticatedClaims({
  principal: userInfo().username,
  groups: [],
  tenant: "default",
});

describe("embedder is reused, not rebuilt per query", () => {
  it("returns the same instance while the model identity is unchanged", () => {
    resetEmbedderCache();
    const a = getEmbedder("fake");
    const b = getEmbedder("fake");
    expect(a).toBe(b);
  });

  it("keys the cache on model identity, so a model switch is NOT served stale", () => {
    // Keying on the provider name would let an EIL_EMBED_MODEL change keep
    // serving vectors from the old model while vecArm matched on the new
    // embed_model — finite, meaningless cosine scores.
    resetEmbedderCache();
    const saved = process.env.EIL_EMBED_MODEL;
    try {
      process.env.EIL_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
      const first = getEmbedder("local");
      process.env.EIL_EMBED_MODEL = "some/other-model";
      const second = getEmbedder("local");
      expect(second).not.toBe(first);
      expect(second.id).not.toBe(first.id);
    } finally {
      if (saved === undefined) delete process.env.EIL_EMBED_MODEL;
      else process.env.EIL_EMBED_MODEL = saved;
      resetEmbedderCache();
    }
  });

  it("reuse is what makes a warm embed fast", async () => {
    resetEmbedderCache();
    const e = getEmbedder("local");
    await e.embed(["warm the ONNX pipeline"]); // pays the load once
    const t = Date.now();
    await getEmbedder("local").embed(["a second query, same process"]);
    // Rebuilding the instance reloaded the model: ~270-300ms measured. Reused,
    // it is single-digit ms. A generous bound still separates the two regimes.
    expect(Date.now() - t).toBeLessThan(120);
  }, 60_000);
});

describe("the embedder window is declared, not assumed", () => {
  it("exposes a window that matches the measured truncation boundary", async () => {
    const e = getEmbedder("local");
    expect(e.windowChars).toBeGreaterThan(0);
    expect(e.windowChars).toBeLessThan(3200); // the old MAX_CHARS was past it
  });

  it("confirms the tail of an over-window text is silently dropped", async () => {
    const e = getEmbedder("local");
    const head = "payment retry backoff policy ".repeat(120); // ~3480 chars
    const [a, b] = await e.embed([`${head} ALPHA tail`, `${head} OMEGA tail`]);
    // Not an assertion that this is FINE — it is the bug, pinned so that a fix
    // (or a model change) visibly moves this number off 1.0.
    expect(cosine(a!, b!)).toBeCloseTo(1.0, 5);
  }, 60_000);
});

describe("confidence metadata", () => {
  let client: Db;
  let dir: string;
  let saved: string | undefined;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "eil-step3-"));
    saved = process.env.EIL_DATABASE_URL;
    process.env.EIL_DATABASE_URL = `pglite://${dir}`;
    client = await connect();
    await migrate(client);
    await upsertDocument(client, normalizePage(fixture("confluence_page.json")));
  });
  afterAll(async () => {
    await client.end();
    if (saved === undefined) delete process.env.EIL_DATABASE_URL;
    else process.env.EIL_DATABASE_URL = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the four signals an agent needs to decide whether to re-query", async () => {
    const r: any = await searchDocs(client, VIEWER, "payment retries", 10);
    expect(r).toHaveProperty("top_score");
    expect(r).toHaveProperty("score_gap");
    expect(r).toHaveProperty("n_above_threshold");
    expect(r).toHaveProperty("arms_contributing");
    expect(r.arms_contributing).toBeGreaterThan(0);
    expect(r.n_above_threshold).toBeGreaterThanOrEqual(1);
  });

  it("degrades to zeroes rather than undefined on an empty result set", async () => {
    const r: any = await searchDocs(client, VIEWER, "zzzz-no-such-term-anywhere", 10);
    expect(r.results).toHaveLength(0);
    expect(r.top_score).toBe(0);
    expect(r.arms_contributing).toBe(0);
  });

  it("does not disturb the existing result shape", async () => {
    const r: any = await searchDocs(client, VIEWER, "payment retries", 10);
    expect(r.route).toBeTruthy();
    expect(r.executor).toBeTruthy();
    expect(Array.isArray(r.results)).toBe(true);
  });
});
