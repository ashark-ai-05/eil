import { describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import { assignClusters, backfillSignatures, buildCentroids } from "../embed/buildivf.js";
import { loadCentroids } from "../embed/ivf.js";
import { narrowEmbedder, openTestDb, seedDoc } from "./helpers/db.js";

describe("ivf over window vectors", () => {
  it("signs every window, not just the first per chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, { id: "conf:1", text: "a".repeat(600), headingPath: "Page" });
    await backfill(db, narrowEmbedder, { reembed: true });
    await backfillSignatures(db, narrowEmbedder.id);
    const r = await db.query("SELECT count(*)::int AS n FROM chunk_vectors WHERE sig IS NULL");
    expect(r.rows[0].n).toBe(0);
  });

  it("assigns a cluster to every window", async () => {
    const db = await openTestDb();
    for (let i = 0; i < 8; i++) {
      await seedDoc(db, { id: `conf:${i}`, text: `${i}`.repeat(600), headingPath: "Page" });
    }
    await backfill(db, narrowEmbedder, { reembed: true });
    await backfillSignatures(db, narrowEmbedder.id);
    await buildCentroids(db, narrowEmbedder.id, { nlist: 2 });
    const centroids = await loadCentroids(db, narrowEmbedder.id);
    await assignClusters(db, narrowEmbedder.id, centroids);
    const r = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE cluster_id IS NULL",
    );
    expect(r.rows[0].n).toBe(0);
  });
});
