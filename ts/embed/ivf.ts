/**
 * The coarse stage of the vector funnel: binary signatures and IVF clustering.
 *
 * Both are computed in Node from vectors that already exist — no re-embedding,
 * no model call. The signature is the sign of each dimension, which is why the
 * exact rescore can recover everything the quantization loses: the sign pattern
 * is enough to rank candidates, and the float vector is still there to score
 * them properly.
 */

import type { Db } from "../db.js";

/**
 * Sign signature: one bit per dimension, MSB-first, as a varbit literal.
 *
 * Stored vectors are unit-normalized, so sign is scale-free and the Hamming
 * distance between two signatures is a monotone proxy for angular distance —
 * good enough to ORDER candidates, not good enough to score them. That is the
 * entire design: 63.5% recall@10 on its own, 100% once survivors are rescored.
 */
export function signature(v: Float32Array | number[]): string {
  let out = "";
  for (let i = 0; i < v.length; i++) out += (v[i] as number) >= 0 ? "1" : "0";
  return out;
}

/** Hamming distance, for calibration in Node. Postgres uses bit_count(a # b). */
export function hamming(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d += 1;
  return d + Math.abs(a.length - b.length);
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};

/**
 * `nlist = sqrt(n)`, the standard IVF heuristic, clamped so a tiny corpus does
 * not end up with one vector per cluster (where the true neighbours scatter and
 * recall collapses — measured 45.5% at nprobe=1 with 21 chunks/cluster) and a
 * huge one does not get an unmanageable centroid table.
 */
export function suggestNlist(n: number): number {
  return Math.max(16, Math.min(16_384, Math.round(Math.sqrt(n))));
}

/**
 * Spherical k-means. Vectors are unit-norm, so cosine is a dot product and the
 * update step is "sum the members and renormalise".
 *
 * Deterministic: seeded, evenly-strided initial centroids and a fixed iteration
 * count. A clustering that differs between runs would make every recall
 * measurement incomparable with the last one, which defeats the calibration.
 */
export function kmeans(
  vectors: readonly Float32Array[],
  k: number,
  iterations = 15,
): { centroids: Float32Array[]; assign: Int32Array } {
  const dim = vectors[0]?.length ?? 0;
  const centroids: Float32Array[] = [];
  for (let i = 0; i < k; i++) {
    const src = vectors[Math.floor((i * vectors.length) / k)];
    centroids.push(Float32Array.from(src ?? new Float32Array(dim)));
  }
  const assign = new Int32Array(vectors.length);
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 0; i < vectors.length; i++) {
      let best = Number.NEGATIVE_INFINITY;
      let bi = 0;
      for (let c = 0; c < k; c++) {
        const s = dot(vectors[i]!, centroids[c]!);
        if (s > best) {
          best = s;
          bi = c;
        }
      }
      if (assign[i] !== bi) moved += 1;
      assign[i] = bi;
    }
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < vectors.length; i++) {
      const a = assign[i]!;
      counts[a]! += 1;
      const s = sums[a]!;
      const v = vectors[i]!;
      for (let j = 0; j < dim; j++) s[j] = (s[j] as number) + (v[j] as number);
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // empty cluster keeps its previous centroid
      const s = sums[c]!;
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += s[j]! * s[j]!;
      norm = Math.sqrt(norm) || 1;
      const c2 = centroids[c]!;
      for (let j = 0; j < dim; j++) c2[j] = s[j]! / norm;
    }
    if (moved === 0) break; // converged
  }
  return { centroids, assign };
}

/** The nprobe nearest cluster ids for a query vector. */
export function probeClusters(
  query: Float32Array | number[],
  centroids: ReadonlyArray<{ clusterId: number; centroid: number[] }>,
  nprobe: number,
): number[] {
  return centroids
    .map((c) => ({ id: c.clusterId, s: dot(query, c.centroid) }))
    .sort((a, b) => b.s - a.s || a.id - b.id)
    .slice(0, nprobe)
    .map((c) => c.id);
}

export interface Centroid {
  clusterId: number;
  centroid: number[];
}

export async function loadCentroids(client: Db, embedModel: string): Promise<Centroid[]> {
  const res = await client.query(
    "SELECT cluster_id, centroid FROM ivf_centroids WHERE embed_model = $1 ORDER BY cluster_id",
    [embedModel],
  );
  return res.rows.map((r: any) => ({
    clusterId: Number(r.cluster_id),
    centroid: (r.centroid as number[]).map(Number),
  }));
}

/**
 * The recall gate. Chosen nprobe is the SMALLEST value clearing this against a
 * full exact scan — not a round number, and not inherited from another corpus.
 */
export const RECALL_GATE = 0.98;

/**
 * Default oversample, and a CORRECTION worth recording.
 *
 * An earlier measurement on one corpus showed 8x and 16x giving identical
 * recall, and that was turned into a fixed constant. It was an artifact: on that
 * corpus the probed candidate set was smaller than k * oversample, so the
 * oversample never bound. On a second corpus, a full Hamming scan measured
 * 4x -> 0.9333, 8x -> 0.9900, 16x -> 0.9967, 32x -> 1.0000.
 *
 * So oversample IS a knob, it is corpus-dependent, and it is now calibrated
 * alongside nprobe rather than assumed. This value is only the starting point of
 * that sweep.
 */
export const OVERSAMPLE = 8;

/** Ladder swept at full probe to separate quantization loss from cluster loss. */
export const OVERSAMPLE_LADDER = [4, 8, 16, 32, 64] as const;

/**
 * Below this, a recall figure is noise. The demo calibrated on 3 mined queries
 * and produced a number that looked authoritative and was not.
 */
export const MIN_CALIBRATION_QUERIES = 30;
