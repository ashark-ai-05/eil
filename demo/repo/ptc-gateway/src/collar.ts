/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Price collar — the cheapest control in the set, and the only one with no
 * external dependency at all.
 */

/**
 * Whether a price sits inside the collar around the reference price.
 *
 * A reference price we do not have is not a wide collar, it is an unevaluable
 * control, and unevaluable rejects. Same rule as the credit check; it is worth
 * stating in both places because the temptation to default to "allow" is
 * strongest on the controls that look trivial.
 */
export function checkCollar(price: number, referencePrice: number, collarBps: number): boolean {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  const deviationBps = (Math.abs(price - referencePrice) / referencePrice) * 10_000;
  return deviationBps <= collarBps;
}
