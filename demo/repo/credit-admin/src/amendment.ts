/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Counterparty limit amendments.
 *
 * Amending a limit is a two person job and credit-admin will not let it be
 * anything else. One Risk Ops user raises the amendment; a second, different
 * Risk Ops user approves it. The separation is enforced here rather than left
 * to procedure and a runbook, which is what PTR-392 asked for — before that it
 * was a convention written on a wiki page, and it was not always followed.
 */

export type AmendmentState = "pending" | "approved" | "rejected" | "withdrawn";

export interface Amendment {
  id: string;
  counterparty: string;
  /** Limits are per counterparty AND entity. The same name appears more than once. */
  entity: string;
  newLimit: number;
  previousLimit: number;
  /**
   * Read in the quarterly credit review by people who were not in the room.
   * "As agreed" is not a reason; the checker is expected to send those back.
   */
  reason: string;
  raisedBy: string;
  raisedAtMs: number;
  approvedBy: string | null;
  approvedAtMs: number | null;
  state: AmendmentState;
}

export const MIN_REASON_CHARS = 20;

export type RaiseResult =
  | { ok: true; amendment: Amendment }
  | { ok: false; error: string };

/**
 * Raise an amendment. It sits in the pending queue and has no effect yet.
 */
export function raise(
  input: Omit<Amendment, "id" | "state" | "approvedBy" | "approvedAtMs" | "raisedAtMs">,
  id: string,
  now: number = Date.now(),
): RaiseResult {
  if (input.reason.trim().length < MIN_REASON_CHARS) {
    return { ok: false, error: "reason must stand on its own to a reader who was not there" };
  }
  if (!Number.isFinite(input.newLimit) || input.newLimit < 0) {
    return { ok: false, error: "new limit must be a non-negative number" };
  }
  return {
    ok: true,
    amendment: {
      ...input,
      id,
      raisedAtMs: now,
      approvedBy: null,
      approvedAtMs: null,
      state: "pending",
    },
  };
}

export type ApprovalResult =
  | { ok: true; amendment: Amendment }
  | { ok: false; error: string };

/**
 * Approve a pending amendment on behalf of a second user.
 *
 * The maker-checker rule is the first check in this function and it is not
 * conditional on anything. In particular it does not consult the approver's
 * roles: holding both the raiser and approver roles does not get you round it,
 * which was confirmed in UAT under PTR-392. Separation of duties is a property
 * of the two identities, not of what either one is permitted to do.
 *
 * The consequence, stated plainly because people are surprised by it: a user
 * alone on shift cannot move a limit at all. There is no route that involves
 * turning the control off for an hour and nobody in Risk Ops can grant one.
 * Call the other region and borrow a second pair of eyes.
 */
export function approve(
  amendment: Amendment,
  approver: string,
  now: number = Date.now(),
): ApprovalResult {
  if (approver === amendment.raisedBy) {
    return {
      ok: false,
      error: `${approver} raised this amendment and may not approve it`,
    };
  }
  if (amendment.state !== "pending") {
    return { ok: false, error: `amendment is ${amendment.state}, not pending` };
  }
  return {
    ok: true,
    amendment: { ...amendment, approvedBy: approver, approvedAtMs: now, state: "approved" },
  };
}

/**
 * Send a pending amendment back to the raiser.
 *
 * Deliberately available to the same user who raised it — withdrawing your own
 * mistake is not the thing maker-checker exists to prevent, and forcing a
 * second person to clean up a typo would only train people to approve without
 * reading.
 */
export function withdraw(amendment: Amendment): ApprovalResult {
  if (amendment.state !== "pending") {
    return { ok: false, error: `amendment is ${amendment.state}, not pending` };
  }
  return { ok: true, amendment: { ...amendment, state: "withdrawn" } };
}
