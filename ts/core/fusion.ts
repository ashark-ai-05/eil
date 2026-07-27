/**
 * Reciprocal Rank Fusion — owned in-service, deterministic, engine-agnostic.
 * Pure arithmetic on ranks with fixed k and a stable tiebreak on doc id.
 */

export const RRF_K = 60;

/** Fuse named ranked lists (best first) into one ranking: [docId, score] desc, tiebreak id asc. */
export function rrf(
  rankings: Record<string, string[]>,
  weights: Record<string, number> = {},
  k: number = RRF_K,
): Array<[string, number]> {
  const scores = new Map<string, number>();
  for (const [arm, ranked] of Object.entries(rankings)) {
    const w = weights[arm] ?? 1.0;
    ranked.forEach((docId, rank) => {
      scores.set(docId, (scores.get(docId) ?? 0) + w / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort(([idA, sA], [idB, sB]) =>
    sB !== sA ? sB - sA : idA < idB ? -1 : idA > idB ? 1 : 0,
  );
}
