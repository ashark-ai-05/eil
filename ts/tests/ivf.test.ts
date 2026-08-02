/**
 * The vector funnel. Its correctness claim is narrow and testable: with a
 * calibrated index, the funnel must return what the exact scan returns — the
 * coarse stage only chooses WHICH vectors get scored properly, never how.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import {
  backfillSignatures,
  buildCentroids,
  calibrate,
  chosenNprobe,
  chosenOversample,
} from "../embed/buildivf.js";
import { FakeEmbedder } from "../embed/index.js";
import {
  RECALL_GATE,
  hamming,
  kmeans,
  probeClusters,
  signature,
  suggestNlist,
} from "../embed/ivf.js";
import { type Viewer, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";

describe("signatures and clustering (pure)", () => {
  it("signs on the sign bit, one char per dimension", () => {
    //          0.5 -> 1   -0.2 -> 0   0 -> 1 (>= 0)   -1 -> 0
    expect(signature([0.5, -0.2, 0, -1])).toBe("1010");
    expect(signature(new Float32Array([1, 1, 1]))).toBe("111");
    expect(signature([-1, -1])).toBe("00");
  });

  it("Hamming counts differing bits", () => {
    expect(hamming("1010", "1010")).toBe(0);
    expect(hamming("1010", "0101")).toBe(4);
    expect(hamming("1010", "1000")).toBe(1);
  });

  it("nlist follows sqrt(n), clamped at both ends", () => {
    expect(suggestNlist(10_000)).toBe(100);
    expect(suggestNlist(4)).toBe(16); // never one-vector-per-cluster
    expect(suggestNlist(10 ** 12)).toBe(16_384);
  });

  it("k-means is deterministic — a shifting partitioning makes recall incomparable", () => {
    const vs = Array.from({ length: 40 }, (_, i) => {
      const v = new Float32Array(8);
      for (let j = 0; j < 8; j++) v[j] = Math.sin(i * 0.37 + j);
      let n = 0;
      for (let j = 0; j < 8; j++) n += v[j]! * v[j]!;
      n = Math.sqrt(n);
      for (let j = 0; j < 8; j++) v[j]! /= n;
      return v;
    });
    const a = kmeans(vs, 4);
    const b = kmeans(vs, 4);
    expect(Array.from(a.assign)).toEqual(Array.from(b.assign));
  });

  it("probeClusters returns the nearest centroids, nearest first", () => {
    const cents = [
      { clusterId: 0, centroid: [1, 0] },
      { clusterId: 1, centroid: [0, 1] },
      { clusterId: 2, centroid: [-1, 0] },
    ];
    expect(probeClusters([0.9, 0.1], cents, 2)).toEqual([0, 1]);
    expect(probeClusters([-1, 0], cents, 1)).toEqual([2]);
  });
});

describe("the funnel against a real database", () => {
  let client: Db;
  let dir: string;
  let saved: string | undefined;
  const emb = new FakeEmbedder(32); // deterministic, no model load
  const VIEWER: Viewer = viewerFromAuthenticatedClaims({
    principal: userInfo().username,
    groups: [],
    tenant: "default",
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "eil-ivf-"));
    saved = process.env.EIL_DATABASE_URL;
    process.env.EIL_DATABASE_URL = `pglite://${dir}`;
    client = await connect();
    await migrate(client);
    for (let i = 0; i < 60; i++) {
      await upsertDocument(
        client,
        CanonicalDoc.parse({
          id: `confluence:page:ivf-${i}`,
          source: "confluence",
          title: `Doc ${i}`,
          body: `Topic ${i % 6}: retry backoff dunning refund policy variant ${i} with body text.`,
          aclGroups: [],
        }),
      );
    }
    const { backfill } = await import("../embed/backfill.js");
    await backfill(client, emb, {});
  });
  afterAll(async () => {
    await client.end();
    if (saved === undefined) delete process.env.EIL_DATABASE_URL;
    else process.env.EIL_DATABASE_URL = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs every embedded chunk and is resumable", async () => {
    const first = await backfillSignatures(client, emb.id);
    expect(first.written).toBeGreaterThan(0);
    const again = await backfillSignatures(client, emb.id); // nothing left to do
    expect(again.written).toBe(0);
    const gap = await client.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE sig IS NULL",
    );
    expect(gap.rows[0].n).toBe(0);
  });

  it("clusters every embedded chunk and records the assignment counts", async () => {
    const built = await buildCentroids(client, emb.id, { nlist: 6 });
    expect(built.nlist).toBe(6);
    expect(built.assigned).toBeGreaterThan(0);
    const unassigned = await client.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE cluster_id IS NULL",
    );
    expect(unassigned.rows[0].n).toBe(0);
    const total = await client.query(
      "SELECT sum(n_assigned)::int AS n FROM ivf_centroids WHERE embed_model = $1",
      [emb.id],
    );
    expect(total.rows[0].n).toBe(built.assigned);
  });

  it("calibrates, persists the whole curve, and picks the smallest passing nprobe", async () => {
    const cal = await calibrate(client, emb, { probes: [1, 2, 6] });
    expect(cal.points).toHaveLength(3);
    // recall is monotone in nprobe: probing more clusters cannot lose a candidate
    expect(cal.points[2]!.recall10).toBeGreaterThanOrEqual(cal.points[0]!.recall10);
    // Probing ALL clusters removes cluster loss, but NOT quantization loss: the
    // oversample sweep picks the smallest value clearing the gate, so full probe
    // lands at or just above the gate rather than exactly 1.0. Asserting 1.0 was
    // only true while oversample was a fixed constant large enough to hide it.
    expect(cal.points[2]!.recall10).toBeGreaterThanOrEqual(RECALL_GATE - 0.02);
    const rows = await client.query(
      "SELECT nprobe, chosen FROM metrics.ivf_calibration ORDER BY nprobe",
    );
    expect(rows.rows).toHaveLength(3); // the whole curve, not just the winner
    if (cal.chosen !== null) {
      expect(await chosenNprobe(client, emb.id)).toBe(cal.chosen);
      // Same row: oversample is fixed for the whole calibrate() run, and only
      // the winning nprobe row is marked chosen.
      expect(await chosenOversample(client, emb.id)).toBe(cal.oversample);
    }
  });

  it("vecArm reads the calibrated oversample, not the compiled-in constant", async () => {
    // Regression coverage for I-2: vecArm used to bind the OVERSAMPLE constant
    // (8) into every query, ignoring the per-corpus oversample calibrate()
    // computes and persists. This test seeds its OWN calibration row rather
    // than depending on the previous test's emergent `cal.chosen` — on this
    // coarse nlist=6 corpus, cluster loss alone can keep every nprobe below
    // RECALL_GATE regardless of oversample, so `cal.chosen` legitimately comes
    // out null sometimes and this test would prove nothing if it rode on that.
    // The wiring under test here is independent of whether THIS corpus's own
    // calibration happens to clear the gate — it only asks: does vecArm read
    // chosenOversample(), or still the constant?
    const saved = (await client.query("SELECT id, chosen FROM metrics.ivf_calibration"))
      .rows as Array<{
      id: number;
      chosen: boolean;
    }>;
    await client.query("UPDATE metrics.ivf_calibration SET chosen = false");
    // 17 is off OVERSAMPLE_LADDER and off the reverted OVERSAMPLE constant (8)
    // — unambiguous evidence of which one the query actually used.
    const inserted = await client.query(
      "INSERT INTO metrics.ivf_calibration" +
        " (embed_model, n_chunks, nlist, nprobe, oversample, recall_10, queries, chosen)" +
        " VALUES ($1, 60, 6, 1, 17, 1.0000, 30, true) RETURNING id",
      [emb.id],
    );
    try {
      const calls: Array<{ text: string; params: any[] }> = [];
      const spy: Db = {
        query: async (text: string, params: any[] = []) => {
          calls.push({ text, params });
          return client.query(text, params);
        },
        end: () => client.end(),
      };
      await searchDocs(spy, VIEWER, "retry backoff dunning", 10, emb);
      const funnel = calls.find((c) => c.text.includes("chunk_vectors v JOIN documents d"));
      expect(funnel).toBeDefined();
      // Bind order in vecArm's query (ts/search.ts): $10 = limit * oversample,
      // i.e. params[9] zero-indexed. limit is 10 here (searchDocs' 4th arg).
      expect(funnel!.params[9]).toBe(10 * 17);
    } finally {
      // Leave calibration state exactly as this test found it.
      await client.query("DELETE FROM metrics.ivf_calibration WHERE id = $1", [
        inserted.rows[0].id,
      ]);
      for (const row of saved) {
        await client.query("UPDATE metrics.ivf_calibration SET chosen = $1 WHERE id = $2", [
          row.chosen,
          row.id,
        ]);
      }
    }
  });

  it("returns the SAME results as the exact scan once calibrated", async () => {
    // The funnel narrows which vectors get scored; it must not change the answer.
    const withIndex: any = await searchDocs(client, VIEWER, "retry backoff dunning", 10, emb);
    await client.query("UPDATE metrics.ivf_calibration SET chosen = false");
    const exact: any = await searchDocs(client, VIEWER, "retry backoff dunning", 10, emb);
    expect(withIndex.results.map((r: any) => r.id)).toEqual(exact.results.map((r: any) => r.id));
  });

  it("degrades to the exact scan when the index is absent, rather than failing", async () => {
    await client.query("DELETE FROM ivf_centroids");
    await client.query("UPDATE metrics.ivf_calibration SET chosen = false");
    const r: any = await searchDocs(client, VIEWER, "refund policy", 10, emb);
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
  });
});
