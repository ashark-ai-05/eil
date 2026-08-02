import { describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import {
  assignClusters,
  backfillSignatures,
  buildCentroids,
  calibrate,
} from "../embed/buildivf.js";
import type { Embedder } from "../embed/index.js";
import { loadCentroids } from "../embed/ivf.js";
import { searchDocs } from "../search.js";
import { narrowEmbedder, openTestDb, seedDoc, testViewer } from "./helpers/db.js";

/** Wider than narrowEmbedder (32 dims vs 8), same char-code-sum-mod-dim
 *  construction: deterministic, no model load, forces windowing. Local to
 *  this one test, which exists specifically to make a genuinely-binding LIMIT
 *  reachable — narrowEmbedder's 8 dimensions give only 256 distinct
 *  signatures, so Hamming ordering there is close to random and a
 *  fix-round-2 review found nothing below the full 64x OVERSAMPLE_LADDER
 *  rung clearing RECALL_GATE on this test's corpus (4/8/16 -> ~0.10/0.17/0.35
 *  recall), and that 64x rung's cap (640) exceeded the 592-row corpus then in
 *  use — so the test's own "genuinely binds" claim was false: recall=1.0000
 *  was the same non-binding-candidate-set arithmetic identity documented on
 *  OVERSAMPLE in ts/embed/ivf.ts, not a measurement.
 *
 *  Both 32 and 64 dims were tried here; both still need the full 64x rung to
 *  clear the gate on this content (the near-duplicate windows within one
 *  topic's repeated-sentence chunks appear to be the harder constraint, not
 *  embedding dimensionality — consistent with "rows per cluster" being what
 *  actually drives the required oversample, per ts/embed/ivf.ts). Rather than
 *  chase a sub-64 rung further, the corpus below is sized so the 64x cap
 *  (640) still sits well under the total row count (~1,185) — genuinely
 *  binding, just not below the ladder's top rung. Documented honestly rather
 *  than claimed otherwise: this test proves the funnel stays correct under a
 *  real (if maximal) quantization cut, not under a merely-typical one. */
const wideEmbedder: Embedder = {
  id: "test:wide32",
  windowChars: 100,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Array(32).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 32]! += t.charCodeAt(i) / 1000;
      const n = Math.hypot(...v) || 1;
      return Float32Array.from(v.map((x) => x / n));
    });
  },
};

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
    // This test forces genuine windowing at a corpus large enough that the
    // LIMIT clause actually restricts `cand` below the total row count, then
    // checks the funnel still reproduces the exact scan.
    //
    // The guard below checks against `cal.oversample` — the value
    // chosenOversample() will actually return and vecArm will actually bind —
    // not the OVERSAMPLE constant. Guarding against the constant was the
    // original mistake: vecArm reads chosenOversample() whenever a `chosen`
    // row exists (which it does the moment calibrate() succeeds below), so
    // the constant is not what determines whether the LIMIT binds.
    const db = await openTestDb();
    // Genuinely different vocabulary per topic, not one boilerplate sentence
    // differing only by an embedded number — a shared template dominates a
    // char-code-sum embedding and swamps the small per-doc numeric
    // difference, leaving too little real signal for quantization to
    // preserve once the candidate LIMIT actually cuts.
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
    const N = 100;
    for (let i = 0; i < N; i++) {
      const topic = topics[i % topics.length]!;
      await seedDoc(db, {
        id: `conf:limit-${i}`,
        text: `${topic} `.repeat(12),
        headingPath: "Page",
      });
    }
    await backfill(db, wideEmbedder, { reembed: true });
    const total = (await db.query("SELECT count(*)::int AS n FROM chunk_vectors")).rows[0].n;

    await backfillSignatures(db, wideEmbedder.id);
    await buildCentroids(db, wideEmbedder.id, {});
    const centroids = await loadCentroids(db, wideEmbedder.id);
    await assignClusters(db, wideEmbedder.id, centroids);
    const cal = await calibrate(db, wideEmbedder, {});
    // Must actually clear the recall gate, or `probes` stays null in vecArm
    // and the LIMIT branch under test never runs.
    expect(cal.chosen).not.toBeNull();
    // The whole point of this test: the candidate LIMIT — limit(10) times the
    // oversample ACTUALLY IN EFFECT (cal.oversample, what chosenOversample()
    // will return and vecArm will bind — NOT the OVERSAMPLE constant, which
    // is what the original version of this test guarded against and why it
    // asserted "genuinely binds" while it did not) — must cut below the
    // corpus, or `cand`'s LIMIT clause never restricts anything and this test
    // proves nothing beyond what ivf.test.ts already does. On this corpus
    // `cal.oversample` lands at the full 64x rung (see the comment on
    // wideEmbedder above for why a sub-64 rung was not achieved here), so the
    // 100-doc corpus above is sized well past 10*64=640 specifically so this
    // still holds even at the ladder's top rung.
    expect(total).toBeGreaterThan(10 * cal.oversample);

    const viewer = testViewer();
    const withIndex: any = await searchDocs(db, viewer, "retry backoff dunning", 10, wideEmbedder);
    await db.query("UPDATE metrics.ivf_calibration SET chosen = false");
    const exact: any = await searchDocs(db, viewer, "retry backoff dunning", 10, wideEmbedder);
    expect(withIndex.results.map((r: any) => r.id)).toEqual(exact.results.map((r: any) => r.id));
  });
});
