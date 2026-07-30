/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Publishes one record per counterparty to the gateways.
 *
 * A publish is a single overwrite of that counterparty's entry — keyed per
 * counterparty, so there is no merge to get wrong. Each record carries its
 * publish timestamp, so a gateway can work out how old its view is, and a
 * version, so a gateway can drop a record older than what it already holds.
 */

import type { CounterpartyView, TenorBand } from "../../ptc-gateway/src/psrCache.js";
import { validateBands } from "./bandTable.js";

export interface LimitRecord {
  counterparty: string;
  entity: string;
  limit: number;
  utilisation: number;
}

export interface Sink {
  send(view: CounterpartyView): void;
}

export class Publisher {
  /** Per counterparty|entity, monotonic. Never reset while the process lives. */
  private readonly versions = new Map<string, number>();
  private warmedUp = false;

  constructor(
    private readonly sink: Sink,
    private readonly bands: readonly TenorBand[],
  ) {
    const problems = validateBands(bands);
    if (problems.length > 0) {
      // Refusing to start is the point. A publisher that starts with a bad
      // band table distributes wrong exposure numbers to every gateway, and
      // wrong numbers release orders — where no numbers at all would have
      // rejected them.
      throw new Error(`band table rejected: ${problems.join("; ")}`);
    }
  }

  /**
   * Publish a full set, then mark ourselves warm.
   *
   * The warm-up half of the PTR-388 fix that lives on this side: psr-limits
   * loads and publishes a complete set before it accepts traffic, so a restart
   * during a patching window can no longer leave the gateways holding nothing
   * while live flow is arriving. The other half is in the gateway, which will
   * not open a venue session until it holds a snapshot.
   */
  publishFullSet(records: readonly LimitRecord[], now: number = Date.now()): number {
    for (const record of records) this.publishOne(record, now);
    this.warmedUp = true;
    return records.length;
  }

  /** Publish a single counterparty. Used for intraday updates after warm-up. */
  publishOne(record: LimitRecord, now: number = Date.now()): CounterpartyView {
    const key = `${record.counterparty}|${record.entity}`;
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);

    const view: CounterpartyView = {
      counterparty: record.counterparty,
      entity: record.entity,
      limit: record.limit,
      utilisation: record.utilisation,
      bands: [...this.bands],
      publishedAtMs: now,
      version,
    };
    this.sink.send(view);
    return view;
  }

  /**
   * Whether traffic may be accepted.
   *
   * Checked by the health endpoint the load balancer reads, so a psr-limits
   * that is still loading is not routed to. Deploys go Tuesday and Thursday,
   * never on a Friday and never inside the hour before the XDEM open, which
   * gives this a wide margin — but the check exists because the margin is not
   * a guarantee.
   */
  isReady(): boolean {
    return this.warmedUp;
  }
}
