/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Presettlement credit check — the last of the four controls on the
 * synchronous order path, and the only one that depends on state published by
 * another service.
 *
 * The rule this file exists to enforce is not ours to soften: a pre-trade
 * control that cannot be evaluated has not passed, so the order is rejected.
 * Missing snapshot, stale snapshot, unreadable record — all of them reject.
 * There is no path through this function that admits an order whose exposure
 * we could not compute. See the market access controls page, and PTR-388,
 * where this behaviour was mistaken for a defect.
 */

import { type CounterpartyView, PsrCache } from "./psrCache.js";

/** Reason codes leave the gateway on the reject message and land in the venue drop copy. */
export const REASON_CREDIT_UNAVAILABLE = "credit-unavailable";
export const REASON_CREDIT_EXCEEDED = "credit-exceeded";

/**
 * How old a counterparty view may be and still be relied on.
 *
 * PTR-415 alerts at the same number. Alerting and rejecting share the
 * threshold deliberately: an operator who is being paged about staleness and a
 * gateway that is rejecting on staleness should never disagree about whether
 * the view is usable.
 */
export const MAX_VIEW_AGE_MS = 1_000;

export interface OrderContext {
  counterparty: string;
  /** Our legal entity. Limits are per counterparty AND entity; they do not net. */
  entity: string;
  grossNotional: number;
  tenorDays: number;
}

export type CreditDecision =
  | { pass: true; utilisation: number; limit: number }
  | { pass: false; reason: string; detail: string };

/**
 * Evaluate the presettlement credit check for one order.
 *
 * Every failure mode returns `pass: false`. None of them throws, because a
 * throw would land in the gateway's generic error path, and the generic error
 * path is a place where "we could not evaluate this" could plausibly be
 * confused with "something went wrong, retry". It cannot be retried. It is a
 * rejection.
 */
export function evaluateCreditCheck(
  cache: PsrCache,
  order: OrderContext,
  now: number = Date.now(),
): CreditDecision {
  const view = cache.get(order.counterparty, order.entity);

  // The gateway came up holding nothing, or has never been fed this
  // counterparty. This is the branch that fired ~4,100 times across two XDEM
  // sessions in PTR-388, after psr-limits was restarted into an empty snapshot
  // and the gateways came up before it had finished loading.
  if (view === null) {
    return {
      pass: false,
      reason: REASON_CREDIT_UNAVAILABLE,
      detail: `no presettlement view held for ${order.counterparty}/${order.entity}`,
    };
  }

  // We are still being published to, but not recently enough. An exposure view
  // we know to be out of date is not a weaker basis for a decision than a
  // fresh one — it is not a basis for a decision at all.
  const ageMs = now - view.publishedAtMs;
  if (ageMs > MAX_VIEW_AGE_MS) {
    return {
      pass: false,
      reason: REASON_CREDIT_UNAVAILABLE,
      detail: `presettlement view for ${order.counterparty}/${order.entity} is ${ageMs}ms old`,
    };
  }

  const contribution = exposureContribution(view, order);
  if (contribution === null) {
    return {
      pass: false,
      reason: REASON_CREDIT_UNAVAILABLE,
      detail: `no tenor add-on band covers ${order.tenorDays}d`,
    };
  }

  // Utilisation is checked against the limit BEFORE the order is released.
  // Intraday it only ever goes up: nothing comes off until the overnight
  // netting batch has run, whatever the desk believes about closing trades.
  const projected = view.utilisation + contribution;
  if (projected > view.limit) {
    return {
      pass: false,
      reason: REASON_CREDIT_EXCEEDED,
      detail: `${projected.toFixed(0)} would exceed limit ${view.limit.toFixed(0)}`,
    };
  }

  return { pass: true, utilisation: projected, limit: view.limit };
}

/**
 * Gross notional multiplied by the tenor add-on factor for the band the order
 * falls in. Returns null when no band covers the tenor, which is treated as
 * unevaluable rather than as a zero contribution — a missing band is a gap in
 * reference data, and reference data we do not have is the first example the
 * market access controls page gives of a control that cannot be evaluated.
 */
function exposureContribution(view: CounterpartyView, order: OrderContext): number | null {
  const band = view.bands.find((b) => order.tenorDays >= b.fromDays && order.tenorDays < b.toDays);
  if (band === undefined) return null;
  return order.grossNotional * band.addOnFactor;
}
