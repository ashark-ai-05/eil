/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * The synchronous order path.
 *
 * ptc-gateway is the only one of our components that sits in front of an order
 * on its way to XDEM. Everything in this file runs inside the 250us
 * wire-to-wire budget — client order hitting our NIC to the order leaving it —
 * which is why the control set is small, why it is evaluated in process, and
 * why we are so unwilling to let anything new into it.
 *
 * Controls evaluated here, and the mapping Compliance holds onto our market
 * access obligations:
 *
 *   - order size / max order value
 *   - price collar
 *   - restricted instrument list  (list owned by Compliance)
 *   - presettlement credit check  (out of psr-cache)
 *
 * The kill switch is NOT here. It is a session-level mechanism that withdraws
 * our flow; it does not admit flow that has failed a control, and the two must
 * not be confused.
 */

import { checkCollar } from "./collar.js";
import { type CreditDecision, type OrderContext, evaluateCreditCheck } from "./creditCheck.js";
import type { PsrCache } from "./psrCache.js";
import { isRestricted } from "./restricted.js";

export const REASON_MAX_ORDER_VALUE = "max-order-value";
export const REASON_PRICE_COLLAR = "price-collar";
export const REASON_RESTRICTED_INSTRUMENT = "restricted-instrument";

export interface Order extends OrderContext {
  instrument: string;
  price: number;
  quantity: number;
}

export interface GatewayConfig {
  maxOrderValue: number;
  collarBps: number;
}

export type Verdict =
  | { forward: true }
  | { forward: false; reason: string; detail: string };

/**
 * Evaluate the whole control set and decide whether the order leaves.
 *
 * There is no bypass parameter. Not for a desk head, not for the on-call
 * engineer, not for a client go-live date. There is no manual override and
 * there must never be one built — if you are here to add one, read the market
 * access controls page first, then do not.
 *
 * Controls are evaluated cheapest-first, and the credit check is last because
 * it is the only one that reads state another service publishes.
 */
export function evaluateOrder(
  cache: PsrCache,
  config: GatewayConfig,
  order: Order,
  referencePrice: number,
  now: number = Date.now(),
): Verdict {
  const value = order.price * order.quantity;
  if (value > config.maxOrderValue) {
    return {
      forward: false,
      reason: REASON_MAX_ORDER_VALUE,
      detail: `${value.toFixed(0)} exceeds ${config.maxOrderValue.toFixed(0)}`,
    };
  }

  if (!checkCollar(order.price, referencePrice, config.collarBps)) {
    return {
      forward: false,
      reason: REASON_PRICE_COLLAR,
      detail: `${order.price} outside ${config.collarBps}bps of ${referencePrice}`,
    };
  }

  if (isRestricted(order.instrument)) {
    return {
      forward: false,
      reason: REASON_RESTRICTED_INSTRUMENT,
      detail: `${order.instrument} is on the restricted list`,
    };
  }

  const credit: CreditDecision = evaluateCreditCheck(cache, order, now);
  if (!credit.pass) {
    return { forward: false, reason: credit.reason, detail: credit.detail };
  }

  return { forward: true };
}

/**
 * Whether this gateway may open a venue session yet.
 *
 * Called before the session is established, not after. A gateway that opens a
 * session while its cache is cold will reject every order that needs a credit
 * check — correctly, per the controls page, but the client sees ninety seconds
 * of rejections for something that was our own fault. That is PTR-388, and
 * this is the half of the fix that lives on our side.
 */
export function maySession(cache: PsrCache, expectedCounterparties: number): boolean {
  return cache.isWarm(expectedCounterparties);
}
