import { describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import {
  assignClusters,
  backfillSignatures,
  buildCentroids,
  calibrate,
} from "../embed/buildivf.js";
import { OVERSAMPLE, loadCentroids } from "../embed/ivf.js";
import { searchDocs } from "../search.js";
import { narrowEmbedder, openTestDb, seedDoc, testViewer } from "./helpers/db.js";

describe("ivf over window vectors", () => {
  it("signs every window, not just the first per chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, { id: "conf:1", text: "a".repeat(600), headingPath: "Page" });
    await backfill(db, narrowEmbedder, { reembed: true });
    // The title's claim ("not just the first per chunk") is only meaningful if
    // there IS more than one window here — a regression back to one window per
    // chunk would still leave sig IS NULL at 0 below, so that alone proves
    // nothing about windowing.
    const total = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    expect(total.rows[0].n).toBeGreaterThan(1);
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
    // Same vacuous-on-empty risk as above: "every window" only means something
    // if there are more windows than chunks (8).
    const total = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    expect(total.rows[0].n).toBeGreaterThan(8);
    await backfillSignatures(db, narrowEmbedder.id);
    await buildCentroids(db, narrowEmbedder.id, { nlist: 2 });
    const centroids = await loadCentroids(db, narrowEmbedder.id);
    await assignClusters(db, narrowEmbedder.id, centroids);
    const r = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE cluster_id IS NULL",
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("returns the SAME results as the exact scan even when the candidate LIMIT genuinely binds", async () => {
    // ts/tests/ivf.test.ts's equivalence test ("returns the SAME results...")
    // runs against a 60-single-window-row corpus, well under
    // limit(10)*OVERSAMPLE — the candidate LIMIT in vecArm's `cand` CTE
    // (ts/search.ts) never actually cuts anything there, so it proves
    // equivalence only in the regime where the funnel already IS a full scan.
    // This test forces genuine windowing (narrowEmbedder) at a corpus large
    // enough that the LIMIT clause actually restricts `cand` below the total
    // row count, then checks the funnel still reproduces the exact scan.
    const db = await openTestDb();
    // Genuinely different vocabulary per topic, not one boilerplate sentence
    // differing only by an embedded number — narrowEmbedder is an 8-dim
    // char-code sum, so a shared template dominates the sum and swamps the
    // small per-doc numeric difference, leaving too little real signal for
    // quantization to preserve once the candidate LIMIT actually cuts.
    const topics = [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "kilo lima mike november oscar papa quebec romeo sierra tango",
      "uniform victor whiskey xray yankee zulu apple banana cherry date",
      "elderberry fig grape honeydew imbe jackfruit kiwi lemon mango nectarine",
      "orange papaya quince raspberry strawberry tangerine ugli vanilla walnut",
      "retry backoff dunning refund policy escalation timeout throttle circuit",
      "invoice ledger reconciliation settlement clearing custody margin haircut",
      "latency throughput jitter backpressure saturation congestion queue depth",
    ];
    const N = 50;
    for (let i = 0; i < N; i++) {
      const topic = topics[i % topics.length]!;
      await seedDoc(db, {
        id: `conf:limit-${i}`,
        text: `${topic} `.repeat(12),
        headingPath: "Page",
      });
    }
    await backfill(db, narrowEmbedder, { reembed: true });
    const total = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    // The whole point of this test: the candidate LIMIT (limit=10 * OVERSAMPLE)
    // must be smaller than the corpus, or `cand`'s LIMIT clause never binds and
    // this test proves nothing beyond what ivf.test.ts already does.
    expect(total.rows[0].n).toBeGreaterThan(10 * OVERSAMPLE);

    await backfillSignatures(db, narrowEmbedder.id);
    await buildCentroids(db, narrowEmbedder.id, {});
    const centroids = await loadCentroids(db, narrowEmbedder.id);
    await assignClusters(db, narrowEmbedder.id, centroids);
    const cal = await calibrate(db, narrowEmbedder, {});
    // Must actually clear the recall gate, or `probes` stays null in vecArm
    // and the LIMIT branch under test never runs.
    expect(cal.chosen).not.toBeNull();

    const viewer = testViewer();
    const withIndex: any = await searchDocs(
      db,
      viewer,
      "retry backoff dunning",
      10,
      narrowEmbedder,
    );
    await db.query("UPDATE metrics.ivf_calibration SET chosen = false");
    const exact: any = await searchDocs(db, viewer, "retry backoff dunning", 10, narrowEmbedder);
    expect(withIndex.results.map((r: any) => r.id)).toEqual(exact.results.map((r: any) => r.id));
  });
});
