# PSR Cache Refresh Design

_Space PTR-DEMO · parent: PTR-DEMO_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

Notes from the cache refresh session on 12 Feb. s.iyer (chair), a.whitfield,
d.mercer, me. Written up off the whiteboard, so correct anything I have got
wrong.

Agreed shape: psr-limits publishes a record per counterparty, and each gateway
replaces its entry for that counterparty in place. The snapshot is keyed per
counterparty, so a publish is a single overwrite and there is no merge to get
wrong. I asked what happens when two publishes for the same counterparty arrive
out of order — the answer was that the record carries a version and the gateway
drops anything older than what it already holds. Nobody has written that rule
down.

Each record carries its publish timestamp so a gateway can work out how old its
view is. d.mercer asked how Risk Ops would ever find out that a gateway had
quietly stopped being fed, and there was no answer to that in the room. Raised as
PTR-415.

a.whitfield pointed out that the refresh path is the same one the add-on factors
ride on, and that we have never load tested both moving at the same time.

Actions: s.iyer to write up the version rule. Me to get a staleness case into the
regression pack. d.mercer to come back on who Risk Ops wants alerted.

Nothing on this page was re-checked after the session.
