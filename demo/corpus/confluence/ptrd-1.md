# Pre-Trade Risk Controls — Architecture Overview

_Space PTR-DEMO · parent: PTR-DEMO_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

## What sits where

Every order we send to XDEM on behalf of a client passes through ptc-gateway
first. ptc-gateway is the only one of these components in the synchronous order
path: it evaluates the control set — order size, price collar, restricted
instrument list, and the presettlement credit check — and then either forwards
the order onto the venue session or rejects it back to the client with a reason
code. Nothing else is permitted in that path.

The credit check does not leave the process. ptc-gateway answers it out of
psr-cache, an in-process snapshot of the current limit and utilisation picture.
psr-cache is fed by psr-limits, which owns limit state, holds the utilisation
counters and decides what the numbers actually are. Behind psr-limits again sits
credit-admin, which is where a person changes a limit; credit-admin writes to
psr-limits and never talks to a gateway directly.

Front to back, then: ptc-gateway, then psr-cache, then psr-limits, then
credit-admin. Only the first two are anywhere near latency sensitive. The
further along that chain you go the more it looks like an ordinary internal
service with a database behind it.

## Before you change anything

Read PTR-388. It is the rejection burst after a psr-limits restart and it is the
reason the failure behaviour in the credit path is what it is. People who have
not read it tend to arrive with a proposal to make the check softer.

Limit administration itself — who may change a number, and what approvals apply
to it — is documented elsewhere and out of scope here.

The attached diagram is from the original design review and is still roughly
right, except the box labelled risk-gateway, which is now ptc-gateway.
