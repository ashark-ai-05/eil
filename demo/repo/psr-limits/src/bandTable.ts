/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Tenor add-on factors.
 *
 * Loaded at start of day. The front end carries almost nothing and the long
 * end carries a lot, which is the whole shape of the table.
 *
 * Ownership is unresolved. Nobody has been able to establish who owns these
 * numbers, and the table has not changed in the time anyone has been looking
 * at it. That is recorded here rather than in someone's notes because a table
 * with no owner is a thing that will eventually need one, probably urgently.
 */

import type { TenorBand } from "../../ptc-gateway/src/psrCache.js";

/**
 * Bands are contiguous and half-open: [fromDays, toDays).
 *
 * The gap this leaves at the top is deliberate. A tenor beyond the last band
 * is NOT charged at the last band's factor — it falls through, and a tenor no
 * band covers makes the credit check unevaluable, so the order is rejected.
 * Extending the table is a reference-data change, not a code change, and it is
 * better that an uncovered tenor rejects loudly than that it is silently
 * priced at whatever the long end happens to be.
 */
export const DEFAULT_BANDS: readonly TenorBand[] = [
  { fromDays: 0, toDays: 7, addOnFactor: 0.001 },
  { fromDays: 7, toDays: 30, addOnFactor: 0.005 },
  { fromDays: 30, toDays: 182, addOnFactor: 0.012 },
  { fromDays: 182, toDays: 365, addOnFactor: 0.025 },
  { fromDays: 365, toDays: 1_825, addOnFactor: 0.04 },
  { fromDays: 1_825, toDays: 3_650, addOnFactor: 0.075 },
];

/**
 * Validate a band table before it is published.
 *
 * Run at load, and a failure stops start of day rather than being logged and
 * carried on from. An overlapping or gapped table produces exposure numbers
 * that are wrong rather than absent, and wrong is worse: absent rejects, wrong
 * releases an order against a limit we have miscalculated.
 */
export function validateBands(bands: readonly TenorBand[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ["band table is empty"];

  const sorted = [...bands].sort((a, b) => a.fromDays - b.fromDays);
  if (sorted[0]!.fromDays !== 0) problems.push("band table does not start at 0d");

  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i]!;
    if (band.toDays <= band.fromDays) {
      problems.push(`band ${band.fromDays}-${band.toDays}d is empty or inverted`);
    }
    if (band.addOnFactor < 0) {
      problems.push(`band ${band.fromDays}-${band.toDays}d has a negative add-on factor`);
    }
    const next = sorted[i + 1];
    if (next !== undefined && next.fromDays !== band.toDays) {
      problems.push(
        next.fromDays > band.toDays
          ? `gap between ${band.toDays}d and ${next.fromDays}d`
          : `overlap between ${next.fromDays}d and ${band.toDays}d`,
      );
    }
  }
  return problems;
}
