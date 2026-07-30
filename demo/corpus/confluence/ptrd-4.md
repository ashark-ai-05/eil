# Market Access Controls — Regulatory Obligations

_Space PTR-DEMO · parent: PTR-DEMO / Compliance_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

We are required to operate pre-trade risk controls on every order that reaches a
trading venue under our market access arrangements, and to be able to
demonstrate afterwards that those controls were applied to that order. Two
consequences come up in design discussions often enough to write down, and
neither is negotiable.

First: a control that cannot be evaluated has not passed. If a pre-trade check
cannot be completed — reference data missing, the service unavailable, the credit
exposure view too old to be relied on — the order MUST be rejected. Fail closed
is the only defensible behaviour. Letting the order through and reconciling
afterwards is not a position we can put in front of a regulator, and it is not a
position this desk will support.

Second: there is no bypass. Not for a desk head, not for the on-call engineer,
not for a client go-live date. There is no manual override and there must never
be one built. The kill switch is a different mechanism and should not be
confused with a bypass: it withdraws our flow, it does not admit flow that has
failed a control.

The specific obligations sit in the market access rules the venue memberships
are subject to, and Compliance holds the mapping from those rules to the
controls in ptc-gateway. This page deliberately does not quote article numbers,
because they move and this page will not be updated when they do. Ask Compliance
for the current citation before you put one in a design document.
