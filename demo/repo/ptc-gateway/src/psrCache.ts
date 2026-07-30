/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * The gateway's local view of presettlement exposure.
 *
 * Shape agreed at the cache refresh session: psr-limits publishes one record
 * per counterparty, and the gateway replaces its entry for that counterparty
 * in place. Keyed per counterparty, so a publish is a single overwrite and
 * there is no merge to get wrong.
 *
 * This is read on the synchronous order path, inside a 250us wire-to-wire
 * budget that the whole control set has to fit inside. So it is a map lookup
 * and nothing else: no I/O, no lock, no allocation on the read path.
 */

export interface TenorBand {
  fromDays: number;
  /** Exclusive. Bands are contiguous; a tenor no band covers is unevaluable. */
  toDays: number;
  addOnFactor: number;
}

export interface CounterpartyView {
  counterparty: string;
  entity: string;
  limit: number;
  utilisation: number;
  bands: TenorBand[];
  /** Wall clock at psr-limits when the record was published. */
  publishedAtMs: number;
  /**
   * Monotonic per counterparty, assigned by psr-limits.
   *
   * Two publishes for the same counterparty can arrive out of order, and the
   * gateway drops anything older than what it already holds. This rule was
   * agreed verbally at the cache refresh session and the write-up notes that
   * nobody had written it down; this is where it lives.
   */
  version: number;
}

const key = (counterparty: string, entity: string) => `${counterparty}|${entity}`;

export class PsrCache {
  private readonly views = new Map<string, CounterpartyView>();

  /**
   * Null means we hold no view for this counterparty and entity.
   *
   * Callers must not treat null as "no exposure". It means the credit check
   * cannot be evaluated, and the order is rejected — see creditCheck.ts.
   */
  get(counterparty: string, entity: string): CounterpartyView | null {
    return this.views.get(key(counterparty, entity)) ?? null;
  }

  /**
   * Apply a published record, dropping anything older than what we hold.
   *
   * Returns whether the record was applied, so the publisher's client can
   * count drops. A sustained non-zero drop count means publishes are being
   * reordered on the wire, which is worth knowing about and is invisible
   * otherwise.
   */
  apply(view: CounterpartyView): boolean {
    const held = this.views.get(key(view.counterparty, view.entity));
    if (held !== undefined && held.version >= view.version) return false;
    this.views.set(key(view.counterparty, view.entity), view);
    return true;
  }

  /**
   * Age of the oldest view we hold, or null when we hold nothing.
   *
   * Exported as a gauge and alerted on at 1s by PTR-415. The gateway cannot
   * tell the difference between "psr-limits has gone quiet" and "psr-limits is
   * publishing and we are not receiving it", and from the order path's point
   * of view there is no difference: both end in a rejection.
   */
  oldestViewAgeMs(now: number = Date.now()): number | null {
    let oldest: number | null = null;
    for (const view of this.views.values()) {
      const age = now - view.publishedAtMs;
      if (oldest === null || age > oldest) oldest = age;
    }
    return oldest;
  }

  /**
   * Whether the gateway holds enough to open a venue session.
   *
   * The warm-up fix from PTR-388. The gateway will not open an XDEM session
   * until it holds a snapshot, so it can no longer come up into an empty cache
   * and reject live flow while psr-limits is still loading. The check is here
   * rather than in the session code so that "do we have a usable view of the
   * world" has exactly one definition.
   */
  isWarm(expectedCounterparties: number): boolean {
    return this.views.size >= expectedCounterparties;
  }

  size(): number {
    return this.views.size;
  }
}
