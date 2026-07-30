/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Presettlement exposure.
 *
 * For a single order the contribution is gross notional multiplied by the
 * tenor add-on factor for the band it falls in. Limits are held per
 * counterparty AND legal entity: the same counterparty faced out of two of our
 * entities has two limits and they do not net against one another. This is why
 * the same name appears more than once in credit-admin and why people think
 * they are looking at a duplicate.
 */

import type { TenorBand } from "../../ptc-gateway/src/psrCache.js";

export interface Trade {
  counterparty: string;
  entity: string;
  grossNotional: number;
  tenorDays: number;
  /** Signed: a closing trade is negative. Only end-of-day netting looks at this. */
  direction: 1 | -1;
}

/** Null when no band covers the tenor — unevaluable, not zero. */
export function contribution(trade: Trade, bands: readonly TenorBand[]): number | null {
  const band = bands.find((b) => trade.tenorDays >= b.fromDays && trade.tenorDays < b.toDays);
  if (band === undefined) return null;
  return trade.grossNotional * band.addOnFactor;
}

/**
 * Intraday utilisation.
 *
 * Utilisation only goes up. Every order adds its contribution and nothing
 * comes off until the overnight batch has run, so `direction` is ignored here
 * on purpose — a closing trade adds exposure intraday exactly like an opening
 * one does.
 *
 * Desks assume a closing trade hands them headroom back the same afternoon. It
 * does not, and Risk Ops fields this question more often than any other. If
 * you are reading this because you are about to "fix" it: the fix is a change
 * to the netting policy, agreed with credit, not a change to this function.
 */
export function intradayUtilisation(
  opening: number,
  trades: readonly Trade[],
  bands: readonly TenorBand[],
): { utilisation: number; unevaluable: Trade[] } {
  let utilisation = opening;
  const unevaluable: Trade[] = [];
  for (const trade of trades) {
    const c = contribution(trade, bands);
    if (c === null) {
      unevaluable.push(trade);
      continue;
    }
    utilisation += Math.abs(c);
  }
  return { utilisation, unevaluable };
}

/**
 * End-of-day netting. The only place `direction` is honoured.
 *
 * Run by the overnight batch, never intraday. Separating the two is the entire
 * reason this file has two functions that look like they should be one.
 */
export function nettedExposure(trades: readonly Trade[], bands: readonly TenorBand[]): number {
  let net = 0;
  for (const trade of trades) {
    const c = contribution(trade, bands);
    if (c === null) continue;
    net += c * trade.direction;
  }
  return Math.max(0, net);
}
