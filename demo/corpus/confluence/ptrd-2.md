# Gateway Notes

_Space PTR-DEMO · parent: PTR-DEMO_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

Notes to self while working on the gateway. Not reviewed by anyone, don't treat
this as design.

Latency budget on the XDEM path is 250us wire to wire — client order hitting our
NIC to the order leaving it. The whole control set has to fit inside that, which
is why we are so unwilling to let anything new into it. The presettlement check
is a small part of the budget, under about 40us, though that number is off the
old kit and I never re-ran it after we moved.

The check reads a local snapshot in the gateway process. It does not call
psr-limits. Calling psr-limits over the network is 2-8ms depending on where the
pods land and how loaded it is, which is a non starter in the order path — 8ms is
more than thirty times the entire budget.

Refresh is a push, not a poll: psr-limits publishes on change and the gateway
applies it to the snapshot. Was aiming for 250ms end to end from the change
landing in credit-admin to the gateway acting on it, and I think we got
roughly there, but I haven't measured recently.

There's a staleness cutoff, I think 5s, after which we reject.
Check with the psr-limits team.

The kill switch is a separate path and does not go anywhere near the snapshot —
it stops the session, it does not wave orders past a control.

TODO: document the add-on factor refresh properly
