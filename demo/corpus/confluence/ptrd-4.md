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
cannot be completed — reference data missing, the service unavailable, the
credit exposure view too old to be relied on — the order must be rejected.
Fail closed is the only defensible behaviour, and letting the order through to
reconcile afterwards is not something we can put in front of a regulator. (The
older control inventory in the market access self-assessment pack sets the same
thing out at more length, though several of the service names in it have
changed since.)

Second: there is no bypass. Not for a desk head, not for the on-call engineer,
not for a client go-live date. There is no manual override and there must never
be one built. The kill switch is a different mechanism and should not be
confused with a bypass: it withdraws our flow, it does not admit flow that has
failed a control.

Compliance holds the mapping from the market access rules our venue memberships
are subject to onto the individual controls in ptc-gateway. Their list, as sent
over after the last review:

- order size / max order value — ptc-gateway, sync path
- price collar — ptc-gateway
- restricted instrument list — ptc-gateway, list owned by Compliance
- presettlement credit check — ptc-gateway, out of psr-cache
- kill switch — session level, withdrawal of flow, not an order control
- duplicate / erroneous order detection — believed to be covered upstream in
  the client OMS, nobody has confirmed this, leaving it here as a question

Ask Compliance for the current citation before you put one in a design
document.
