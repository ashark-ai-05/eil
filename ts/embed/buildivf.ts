/**
 * Build the coarse index, then calibrate nprobe against a recall gate.
 *
 * Both are resumable and neither lives in a migration: the spec's rule is that
 * no migration file performs an unbounded UPDATE, because at 20M chunks that is
 * an outage rather than a schema change.
 */

import type { Db } from "../db.js";
import { type Embedder, getEmbedder } from "./index.js";
import {
  type Centroid,
  MIN_CALIBRATION_QUERIES,
  OVERSAMPLE,
  OVERSAMPLE_LADDER,
  RECALL_GATE,
  hamming,
  kmeans,
  loadCentroids,
  probeClusters,
  signature,
  suggestNlist,
} from "./ivf.js";

/** Signatures for every embedded chunk that lacks one. Batched by PK range so an
 *  interrupted run resumes rather than restarting. */
export async function backfillSignatures(
  client: Db,
  embedModel: string,
  batch = 2_000,
): Promise<{ written: number }> {
  let written = 0;
  for (;;) {
    const rows = await client.query(
      "SELECT tenant, doc_id, seq, ord, embedding FROM chunk_vectors" +
        " WHERE embed_model = $1 AND sig IS NULL" +
        " ORDER BY tenant, doc_id, seq, ord LIMIT $2",
      [embedModel, batch],
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      await client.query(
        "UPDATE chunk_vectors SET sig = $1::varbit" +
          " WHERE tenant = $2 AND doc_id = $3 AND seq = $4 AND ord = $5",
        [signature((r.embedding as number[]).map(Number)), r.tenant, r.doc_id, r.seq, r.ord],
      );
      written += 1;
    }
    console.log(`  signatures: ${written}`);
  }
  return { written };
}

/** Sample vectors for clustering. A full read is unnecessary — k-means over a
 *  200k sample yields the same partitioning shape as over 20M. */
async function sampleVectors(
  client: Db,
  embedModel: string,
  limit: number,
): Promise<Array<{ tenant: string; docId: string; seq: number; ord: number; vec: Float32Array }>> {
  const res = await client.query(
    "SELECT tenant, doc_id, seq, ord, embedding FROM chunk_vectors" +
      " WHERE embed_model = $1" +
      " ORDER BY tenant, doc_id, seq, ord LIMIT $2",
    [embedModel, limit],
  );
  return res.rows.map((r: any) => ({
    tenant: r.tenant,
    docId: r.doc_id,
    seq: Number(r.seq),
    ord: Number(r.ord),
    vec: Float32Array.from((r.embedding as number[]).map(Number)),
  }));
}

export async function buildCentroids(
  client: Db,
  embedModel: string,
  opts: { sample?: number; nlist?: number } = {},
): Promise<{ nlist: number; assigned: number }> {
  const sample = await sampleVectors(client, embedModel, opts.sample ?? 200_000);
  if (sample.length === 0) return { nlist: 0, assigned: 0 };
  const nlist = opts.nlist ?? suggestNlist(sample.length);
  const { centroids } = kmeans(
    sample.map((s) => s.vec),
    nlist,
  );

  // Replace atomically: a half-migrated partitioning would silently drop
  // whichever clusters had not been reassigned yet out of every query.
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM ivf_centroids WHERE embed_model = $1", [embedModel]);
    for (let c = 0; c < centroids.length; c++) {
      await client.query(
        "INSERT INTO ivf_centroids (embed_model, cluster_id, centroid) VALUES ($1, $2, $3::float4[])",
        [embedModel, c, Array.from(centroids[c]!)],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  const loaded = await loadCentroids(client, embedModel);
  const assigned = await assignClusters(client, embedModel, loaded);
  for (const c of loaded) {
    await client.query(
      "UPDATE ivf_centroids SET n_assigned = (SELECT count(*) FROM chunk_vectors WHERE embed_model = $1 AND cluster_id = $2)" +
        " WHERE embed_model = $1 AND cluster_id = $2",
      [embedModel, c.clusterId],
    );
  }
  return { nlist, assigned };
}

/** Assign every embedded chunk to its nearest centroid. This is the expensive
 *  half of a rebuild — it touches the whole vector corpus — so it is batched. */
export async function assignClusters(
  client: Db,
  embedModel: string,
  centroids: Centroid[],
  batch = 2_000,
): Promise<number> {
  let done = 0;
  let after: { tenant: string; docId: string; seq: number; ord: number } | null = null;
  for (;;) {
    const rows = await client.query(
      "SELECT tenant, doc_id, seq, ord, embedding FROM chunk_vectors" +
        " WHERE embed_model = $1" +
        "   AND ($2::text IS NULL OR (tenant, doc_id, seq, ord) > ($2, $3, $4, $5))" +
        " ORDER BY tenant, doc_id, seq, ord LIMIT $6",
      [
        embedModel,
        after?.tenant ?? null,
        after?.docId ?? null,
        after?.seq ?? null,
        after?.ord ?? null,
        batch,
      ],
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const [best] = probeClusters((r.embedding as number[]).map(Number), centroids, 1);
      await client.query(
        "UPDATE chunk_vectors SET cluster_id = $1" +
          " WHERE tenant = $2 AND doc_id = $3 AND seq = $4 AND ord = $5",
        [best ?? 0, r.tenant, r.doc_id, r.seq, r.ord],
      );
      done += 1;
    }
    const last = rows.rows[rows.rows.length - 1];
    after = {
      tenant: last.tenant,
      docId: last.doc_id,
      seq: Number(last.seq),
      ord: Number(last.ord),
    };
    console.log(`  assigned: ${done}`);
  }
  return done;
}

export interface CalibrationPoint {
  nprobe: number;
  recall10: number;
  scanned: number;
}

/**
 * Measure recall@10 of the funnel against a full exact scan, per nprobe, and
 * pick the smallest value clearing the gate.
 *
 * Queries come from the eval set if it has any, otherwise from sampled chunk
 * text — a chunk's own text is a legitimate probe for "does this partitioning
 * find the right neighbourhood", which is a property of geometry rather than of
 * relevance, so it does not inherit the synthetic-query problem.
 */
export async function calibrate(
  client: Db,
  embedder: Embedder,
  opts: { probes?: number[]; queries?: number } = {},
): Promise<{
  points: CalibrationPoint[];
  chosen: number | null;
  nlist: number;
  oversample: number;
  oversamplePoints: Array<{ oversample: number; recall10: number }>;
  queries: number;
}> {
  const embedModel = embedder.id;
  const centroids = await loadCentroids(client, embedModel);
  if (centroids.length === 0) throw new Error("no centroids: run `eil ivf build` first");

  const all = await client.query(
    "SELECT tenant, doc_id, seq, ord, cluster_id, sig, embedding FROM chunk_vectors" +
      " WHERE sig IS NOT NULL AND embed_model = $1" +
      " ORDER BY tenant, doc_id, seq, ord",
    [embedModel],
  );
  const corpus = all.rows.map((r: any) => ({
    // NUL-joined, not space-joined: NUL cannot appear in any of these values, so
    // the key can never collide across rows. A space CAN appear in a doc_id and
    // a collision here would silently inflate recall via the exact.includes(k)
    // check in measure() below.
    key: `${r.tenant}\0${r.doc_id}\0${r.seq}\0${r.ord}`,
    cluster: Number(r.cluster_id),
    sig: String(r.sig),
    vec: (r.embedding as number[]).map(Number),
  }));
  if (corpus.length === 0) throw new Error("no signed vectors: run `eil ivf backfill` first");

  const qrows = await client.query("SELECT query FROM eval_queries ORDER BY id LIMIT $1", [
    opts.queries ?? 200,
  ]);
  const queryTexts: string[] = qrows.rows.map((r: any) => r.query as string);
  // TOP UP rather than only falling back. A demo run calibrated on the 3 queries
  // that happened to be mined and printed a recall figure that looked
  // authoritative and was noise. Real queries are better probes, but too few of
  // them is worse than a mixture: recall@10 over 3 queries moves in steps of
  // 3.3%, and the gate is 2% wide.
  if (queryTexts.length < MIN_CALIBRATION_QUERIES) {
    const want = MIN_CALIBRATION_QUERIES - queryTexts.length;
    const sampled = await client.query(
      "SELECT c.text FROM chunks c" +
        " WHERE EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.tenant = c.tenant" +
        "   AND v.doc_id = c.doc_id AND v.seq = c.seq AND v.embed_model = $1)" +
        " ORDER BY c.tenant, c.doc_id, c.seq",
      [embedModel],
    );
    const stride = Math.max(1, Math.floor(sampled.rows.length / want));
    queryTexts.push(
      ...sampled.rows
        .filter((_: unknown, i: number) => i % stride === 0)
        .slice(0, want)
        .map((r: any) => String(r.text).slice(0, 300)),
    );
  }
  if (queryTexts.length === 0) throw new Error("no queries available to calibrate against");

  const qvecs = await embedder.embed(queryTexts);
  const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let s = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i] as number) * (b[i] as number);
    return s;
  };

  /** recall@10 of the funnel at a given (nprobe, oversample), vs a full exact scan. */
  const measure = (nprobe: number, oversample: number) => {
    let hits = 0;
    let scanned = 0;
    for (const qv of qvecs) {
      const exact = corpus
        .map((c, i) => ({ s: dot(qv, c.vec), i }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, 10)
        .map((x) => corpus[x.i]!.key);
      const near = new Set(probeClusters(qv, centroids, nprobe));
      const qsig = signature(qv);
      const cand = corpus.filter((c) => near.has(c.cluster));
      scanned += cand.length;
      const got = cand
        .map((c, i) => ({ h: hamming(c.sig, qsig), i }))
        .sort((a, b) => a.h - b.h || a.i - b.i)
        .slice(0, 10 * oversample)
        .map((x) => cand[x.i]!)
        .map((c) => ({ s: dot(qv, c.vec), key: c.key }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 10)
        .map((x) => x.key);
      hits += got.filter((k) => exact.includes(k)).length;
    }
    return {
      recall10: hits / (qvecs.length * 10),
      scanned: Math.round(scanned / qvecs.length),
    };
  };

  // OVERSAMPLE FIRST, at a full probe. With every cluster probed there is no
  // cluster loss, so whatever recall is missing here is purely what binary
  // quantization threw away — and that is corpus-dependent, which an earlier
  // fixed constant assumed it was not. Choosing it before sweeping nprobe stops
  // the two losses being confounded.
  let oversample = OVERSAMPLE;
  const oversamplePoints: Array<{ oversample: number; recall10: number }> = [];
  for (const o of OVERSAMPLE_LADDER) {
    const r = measure(centroids.length, o);
    oversamplePoints.push({ oversample: o, recall10: r.recall10 });
    if (r.recall10 >= RECALL_GATE) {
      oversample = o;
      break; // smallest that clears the gate; larger only costs rescores
    }
    oversample = o; // nothing cleared it yet — keep the best so far
  }

  // Always measure a FULL probe as the last point. The ladder contains no value
  // equal to an arbitrary nlist, so filtering it to <= nlist meant a small corpus
  // never probed every cluster: the curve plateaued below the gate with no
  // visible ceiling, and "IVF does not suit this corpus" was indistinguishable
  // from "we did not look far enough".
  const ladder = [1, 2, 4, 8, 16, 32, 64, 128, 256].filter((p) => p < centroids.length);
  const probes = opts.probes ?? [...ladder, centroids.length];
  const points: CalibrationPoint[] = probes.map((nprobe) => ({
    nprobe,
    ...measure(nprobe, oversample),
  }));

  // Probing every cluster IS the exact scan — it clears the gate by definition
  // and buys nothing. Adopting it would report a speedup that does not exist.
  const chosen =
    points.find((p) => p.recall10 >= RECALL_GATE && p.nprobe < centroids.length)?.nprobe ?? null;
  for (const p of points) {
    await client.query(
      "INSERT INTO metrics.ivf_calibration" +
        " (embed_model, n_chunks, nlist, nprobe, oversample, recall_10, queries, chosen)" +
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        embedModel,
        corpus.length,
        centroids.length,
        p.nprobe,
        oversample,
        p.recall10.toFixed(4),
        qvecs.length,
        p.nprobe === chosen,
      ],
    );
  }
  return {
    points,
    chosen,
    nlist: centroids.length,
    oversample,
    oversamplePoints,
    queries: qvecs.length,
  };
}

/** The calibrated nprobe for this model, or null if never calibrated / gate never met. */
export async function chosenNprobe(client: Db, embedModel: string): Promise<number | null> {
  const res = await client.query(
    "SELECT nprobe FROM metrics.ivf_calibration WHERE embed_model = $1 AND chosen" +
      " ORDER BY at DESC LIMIT 1",
    [embedModel],
  );
  return res.rows[0] ? Number(res.rows[0].nprobe) : null;
}

export const defaultEmbedder = (): Embedder => getEmbedder();
