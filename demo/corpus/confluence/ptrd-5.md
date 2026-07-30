# Risk Ops Runbook — Limit Amendments

_Space PTR-DEMO · parent: PTR-DEMO / Runbooks_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

Amending a counterparty credit limit is a two person job, and credit-admin will
not let it be anything else.

One Risk Ops user raises the amendment. A second, different Risk Ops user
approves it. credit-admin enforces the separation itself — the approve action is
refused when the approver is the same user who raised the change, and holding
both roles does not get you round it. This came in under PTR-392. Before that it
was a convention written on this page, and it was not always followed.

## Raising

1. credit-admin, Counterparties, find the counterparty. Check you are on the
   right entity before you type anything; the same name appears more than once
   and they are separate lines.
2. Amendment. Enter the new limit and a reason. The reason is read in the
   quarterly credit review by people who were not there, so write something a
   stranger can follow rather than "as agreed".
3. Save. The amendment sits in the pending queue and has no effect yet.

## Approving

4. The second user opens the pending queue and reads the reason, not only the
   number. If the reason does not stand on its own, send it back.
5. Approve. psr-limits takes the change and the gateways follow along shortly
   afterwards.
6. Record the amendment in the shift handover.

If you are alone on shift you cannot complete an amendment. Call the other region
and borrow a second pair of eyes. There is no route that involves turning the
control off for an hour, and asking for one is not a good use of anybody's
afternoon.
