import { describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import {
  assignClusters,
  backfillSignatures,
  buildCentroids,
  calibrate,
} from "../embed/buildivf.js";
import type { Embedder } from "../embed/index.js";
import { toVec } from "../embed/index.js";
import { loadCentroids, probeClusters } from "../embed/ivf.js";
import { searchDocs } from "../search.js";
import { narrowEmbedder, openTestDb, seedDoc, testViewer } from "./helpers/db.js";

/** Wider than narrowEmbedder (32 dims vs 8), same char-code-sum-mod-dim
 *  construction: deterministic, no model load, forces windowing. Local to
 *  this one test, which exists to make genuine CLUSTER narrowing (nprobe)
 *  reachable — narrowEmbedder's 8 dimensions give only 256 distinct
 *  signatures, so Hamming ordering there is close to random and a
 *  fix-round-2 review found nothing below the full 64x OVERSAMPLE_LADDER rung
 *  clearing RECALL_GATE on that corpus.
 *
 *  A fix-round-3 review went further and measured this WIDER embedder's own
 *  ladder on this exact corpus/query/pipeline: at full probe (no cluster
 *  loss), 4x/8x/16x/32x/64x recall was 0.000/0.023/0.100/0.300/0.600 —
 *  NOTHING on OVERSAMPLE_LADDER clears the gate here, including 64x.
 *  `cal.oversample` landing at 64 is buildivf.ts's fall-through
 *  ("oversample = o // keep the best so far", :308) when nothing clears, not
 *  a passing measurement. Worse: the only nprobe values whose pooled
 *  candidate count exceeds the resulting LIMIT (10*64=640) are 32 and 34
 *  (this corpus's nlist), and both of THOSE also collapse to 0.600 recall.
 *  So on this corpus, "calibration succeeds" (cal.chosen non-null) and "the
 *  oversample-based candidate LIMIT binds" are mutually exclusive outcomes —
 *  no corpus we could construct with a deterministic, no-model-load embedder
 *  made the survivor cut bind at a gate-clearing nprobe. Recorded here rather
 *  than re-litigated: the test below proves the funnel stays correct under
 *  genuine CLUSTER loss (nprobe narrowing the candidate pool, independently
 *  verified below), not under a genuine oversample-cap loss — those are two
 *  different mechanisms the funnel narrows candidates by, and only one of
 *  them is exercised here. */
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

  it("returns the same results as the exact scan even when cluster probing genuinely narrows the candidate set", async () => {
    // ts/tests/ivf.test.ts's equivalence test ("returns the SAME results...")
    // runs against a 60-single-window-row corpus, well under
    // limit(10)*OVERSAMPLE — vecArm's `cand` CTE (ts/search.ts) never
    // actually excludes anything there, cluster narrowing included, so it
    // proves equivalence only in the regime where the funnel already IS a
    // full scan. This test forces genuine windowing at a corpus large enough
    // that CLUSTER PROBING (nprobe) actually excludes real candidates — most
    // of the corpus never enters `cand` at all, because it isn't in a probed
    // cluster — then checks the funnel still reproduces the exact scan.
    //
    // NOT under test here: the oversample-based survivor cut inside `cand`
    // (`LIMIT 10 * oversample`). See the comment on wideEmbedder above for
    // why — on this corpus, and on every corpus tried against a
    // deterministic, no-model-load embedder, gate-clearing calibration and a
    // genuinely binding oversample cap never coincide.
    const db = await openTestDb();
    // Genuinely different vocabulary per topic, not one boilerplate sentence
    // differing only by an embedded number — a shared template dominates a
    // char-code-sum embedding and swamps the small per-doc numeric
    // difference, leaving too little real signal for k-means to recover
    // separate clusters from, which is what this test needs nprobe to
    // actually narrow.
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
    // and neither narrowing mechanism under test ever runs.
    expect(cal.chosen).not.toBeNull();

    // The whole point of this test: cluster probing must actually EXCLUDE
    // real candidates — `probes` narrows `cand` to rows whose cluster_id is
    // one of the probed ones (ts/search.ts), so replicate exactly what
    // vecArm computes for the same query (embed, toVec, probeClusters at the
    // calibrated nprobe) and count how many chunk_vectors rows that pool
    // actually contains. If it were >= `total`, nprobe would not be
    // narrowing anything and this test would prove nothing beyond what
    // ivf.test.ts already does.
    const query = "retry backoff dunning";
    const qv = toVec((await wideEmbedder.embed([query]))[0]!);
    const probes = probeClusters(qv, centroids, cal.chosen!);
    const pooled = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE cluster_id = ANY($1::int[])",
      [probes],
    );
    expect(pooled.rows[0].n).toBeLessThan(total);

    const viewer = testViewer();
    const withIndex: any = await searchDocs(db, viewer, query, 10, wideEmbedder);
    await db.query("UPDATE metrics.ivf_calibration SET chosen = false");
    const exact: any = await searchDocs(db, viewer, query, 10, wideEmbedder);
    expect(withIndex.results.map((r: any) => r.id)).toEqual(exact.results.map((r: any) => r.id));
  });
});
