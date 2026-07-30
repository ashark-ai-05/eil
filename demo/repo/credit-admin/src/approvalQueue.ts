/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * The pending amendment queue.
 *
 * Read by Risk Ops when approving, and read by the deploy runbook: step one of
 * deploying psr-limits or credit-admin is checking this queue is empty,
 * because deploying part way through an amendment leaves it in a state nobody
 * has thought about.
 */

import { type Amendment, approve } from "./amendment.js";

export interface AppliedChange {
  counterparty: string;
  entity: string;
  limit: number;
  approvedBy: string;
}

export class ApprovalQueue {
  private readonly pending = new Map<string, Amendment>();
  private readonly history: Amendment[] = [];

  add(amendment: Amendment): void {
    this.pending.set(amendment.id, amendment);
  }

  /** What the second user reads. Reason included, because the reason is the point. */
  list(): Amendment[] {
    return [...this.pending.values()].sort((a, b) => a.raisedAtMs - b.raisedAtMs);
  }

  isEmpty(): boolean {
    return this.pending.size === 0;
  }

  /**
   * Approve and hand the change on to psr-limits.
   *
   * Returns the change to apply, or an error. The maker-checker decision is
   * delegated to `approve` rather than re-implemented here — one rule, one
   * place. A queue that made its own judgement about who may approve would be
   * a second implementation of a control, and second implementations drift.
   */
  approveById(
    id: string,
    approver: string,
    now: number = Date.now(),
  ): { ok: true; change: AppliedChange } | { ok: false; error: string } {
    const amendment = this.pending.get(id);
    if (amendment === undefined) return { ok: false, error: `no pending amendment ${id}` };

    const result = approve(amendment, approver, now);
    if (!result.ok) return result;

    this.pending.delete(id);
    this.history.push(result.amendment);
    return {
      ok: true,
      change: {
        counterparty: result.amendment.counterparty,
        entity: result.amendment.entity,
        limit: result.amendment.newLimit,
        approvedBy: approver,
      },
    };
  }

  /**
   * Every amendment that has left the queue, in the order it left.
   *
   * Kept because "demonstrate afterwards that the control was applied" is an
   * obligation and not a nice-to-have. Each entry carries both names, so the
   * separation of duties is evidenced rather than asserted.
   */
  auditTrail(): readonly Amendment[] {
    return this.history;
  }
}
