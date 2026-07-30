# PSR limit model - notes

_Space PTR-DEMO · parent: PTR-DEMO_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

Working notes on how the PSR number is actually arrived at. Somebody should turn
this into a proper page one day.

For a single order the exposure contribution is gross notional multiplied by a
tenor add-on factor. The factors are banded by tenor — the front end carries
almost nothing, the long end carries a lot — and psr-limits loads the band table
at start of day. I could not establish who owns the bands. The table has not
changed in the time I have been looking at it.

Limits are held per counterparty and legal entity. The same counterparty faced
out of two of our entities has two limits, and they do not net against one
another, which is why the same name appears more than once in credit-admin and
why people think they are looking at a duplicate.

Netting is applied end of day only, never intraday. Intraday, utilisation only
goes up: every order adds its contribution and nothing comes off until the
overnight batch has run. Desks assume a closing trade hands them headroom back
the same afternoon. It does not. Risk Ops fields this question more often than
any other.

Utilisation is checked against the limit before the order is released, not after.
