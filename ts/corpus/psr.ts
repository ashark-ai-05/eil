/**
 * The synthetic pre-trade risk corpus, authored once here and projected twice by
 * `scripts/build-corpus.ts` — paste-ready markdown for a human to create in
 * Confluence/Jira, and fixture JSON for EIL to ingest.
 *
 * SYNTHETIC. Every name, number, counterparty and venue below is invented. The
 * register is deliberate: thin, hedged, drifting in terminology, one page plainly
 * stale and not marked as such. Tidy synthetic docs make retrieval look easy, so
 * do not tidy these. Two facts are deliberately absent from every page body —
 * what happens to orders already working at a venue when a limit is reduced, and
 * any cross-currency rate source. Adding either breaks the demo.
 *
 * WRAPPING CONSTRAINT. Bodies are hard-wrapped at ~78 columns, but the hedge
 * phrases downstream detection looks for must not straddle a newline: `i think`,
 * `roughly`, `haven't measured`, `check with`, `not sure`, `probably`,
 * `should be`, `approximately`, `was aiming for`, `credit exposure`. Whitespace
 * is normalised before matching, so a split would still be found — but a corpus
 * whose signal depends on where a hand-wrap happened to fall is fragile. When
 * you reword a paragraph, re-flow it so each of those phrases stays on one line.
 */

/** Confluence connector wire shape — snake_case, because that is what ingest parses. */
export interface ConfluenceFixture {
  id: string;
  title: string;
  url: string | null;
  author: string;
  created: string;
  updated: string;
  ancestors: string[];
  acl_groups: string[];
  body: string;
}

/** Jira connector wire shape. */
export interface JiraFixture {
  key: string;
  url: string;
  fields: {
    summary: string;
    status: string;
    issuetype: string;
    project: string;
    reporter: string;
    created: string;
    updated: string;
    description: string;
    comments: { author: string; body: string }[];
    /**
     * Jira's own typed dependency graph. Present here because ingest prefers it
     * over the prose scraper, so an issue whose links the paste instructions
     * describe must encode them too or the two demo modes get different graphs.
     */
    issue_links?: { type: string; key: string }[];
  };
}

const page = (id: string) => `https://confluence.example.com/display/PTR-DEMO/${id}`;
const issue = (key: string) => `https://jira.example.com/browse/${key}`;

export const CONFLUENCE_SOURCE: ConfluenceFixture[] = [
  {
    id: "ptrd-1",
    title: "Pre-Trade Risk Controls — Architecture Overview",
    url: page("ptrd-1"),
    author: "s.iyer",
    created: "2024-09-03T10:20:00+00:00",
    updated: "2026-03-11T15:05:00+00:00",
    ancestors: ["PTR-DEMO"],
    acl_groups: [],
    body: `
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

The attached diagram is from the original design review and is still
roughly right, except the box labelled risk-gateway, which is now ptc-gateway.
`,
  },
  {
    id: "ptrd-2",
    title: "Gateway Notes",
    url: page("ptrd-2"),
    author: "a.whitfield",
    // Fourteen months before PTR-401 was raised. This page is stale and says so
    // nowhere; its author has since left. That is the point of it.
    created: "2024-11-19T08:41:00+00:00",
    updated: "2025-05-06T16:40:00+00:00",
    ancestors: ["PTR-DEMO"],
    acl_groups: [],
    body: `
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
`,
  },
  {
    id: "ptrd-3",
    title: "PSR limit model - notes",
    url: page("ptrd-3"),
    author: "d.mercer",
    created: "2024-10-02T13:02:00+00:00",
    updated: "2026-01-15T09:48:00+00:00",
    ancestors: ["PTR-DEMO"],
    acl_groups: [],
    body: `
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
`,
  },
  {
    id: "ptrd-4",
    title: "Market Access Controls — Regulatory Obligations",
    url: page("ptrd-4"),
    author: "s.iyer",
    created: "2024-08-14T11:00:00+00:00",
    updated: "2026-06-22T10:12:00+00:00",
    ancestors: ["PTR-DEMO", "Compliance"],
    acl_groups: [],
    body: `
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
`,
  },
  {
    id: "ptrd-5",
    title: "Risk Ops Runbook — Limit Amendments",
    url: page("ptrd-5"),
    author: "d.mercer",
    created: "2025-01-20T09:30:00+00:00",
    updated: "2026-05-28T14:22:00+00:00",
    ancestors: ["PTR-DEMO", "Runbooks"],
    acl_groups: [],
    body: `
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
control off for an hour, and no one in Risk Ops can grant one.
`,
  },
  {
    id: "ptrd-6",
    title: "Credit Service Deployment Runbook",
    url: page("ptrd-6"),
    author: "s.iyer",
    created: "2025-02-11T16:00:00+00:00",
    updated: "2026-04-02T08:35:00+00:00",
    ancestors: ["PTR-DEMO", "Runbooks"],
    acl_groups: [],
    body: `
## Deploying psr-limits and credit-admin

Standard change, raised in the change tool the day before. Deploys go Tuesday
and Thursday, never on a Friday and never inside the hour before the XDEM open.

1. Check the pending amendment queue in credit-admin is empty. Deploying part way
   through an amendment is survivable but the audit trail becomes hard to explain.
2. Export the service credentials on the deploy host:

       aws_access_key_id = AKIAIOSFODNN7EXAMPLE
       DATABASE_URL=postgres://svc:hunter2correct@db.internal:5432/psr

3. Run make deploy. It drains the pod, applies migrations, then rolls forward one
   instance at a time.
4. Watch the publish rate on the psr-limits dashboard for five minutes. It should
   settle back to its usual shape. If it does not, the gateways are not being fed;
   roll back rather than debug it with the market open.
5. Read one limit back for CPTY-ALPHA and confirm it is the number it was before
   the deploy.
6. Close the change and note the image tag in the handover.

Rollback is the previous image and the same steps. The key above is supposed to
be rotated monthly; it has not been rotated since this runbook was written.
`,
  },
  {
    id: "ptrd-7",
    title: "Counterparty Static Data",
    url: page("ptrd-7"),
    author: "d.mercer",
    created: "2024-09-30T12:15:00+00:00",
    updated: "2026-07-01T11:40:00+00:00",
    ancestors: ["PTR-DEMO"],
    acl_groups: ["grp-risk-ops"],
    body: `
Restricted to grp-risk-ops deliberately. A counterparty's credit line is our own
view of that counterparty's creditworthiness. It is commercially sensitive, and
no client should be able to read their own number — or anybody else's — off an
internal wiki. Two requests to open this page to all of engineering have been
declined. If you need a limit for a test, invent one.

CPTY-ALPHA is a large dealer, faced out of the London entity, and carries the
biggest presettlement line we run on this venue at 250m USD equivalent, with a
sub-limit of 60m beyond five years tenor. Utilisation rarely gets past half of
that outside index roll weeks.

CPTY-BRAVO is a regional bank and is faced out of both London and Singapore. The
London line is 80m and Singapore is 25m. Those are separate lines and neither one
lends headroom to the other; CPTY-BRAVO's treasury team has asked us to net them
twice and been told no twice. CPTY-BRAVO runs much closer to its line than
CPTY-ALPHA does and is the name Risk Ops watches on a busy day.

Both are reviewed annually by credit. The review dates live in the credit system
and not on this page, because this page would not be updated.
`,
  },
  {
    id: "ptrd-8",
    title: "PSR Cache Refresh Design",
    url: page("ptrd-8"),
    author: "n.okafor",
    created: "2026-02-12T17:30:00+00:00",
    updated: "2026-02-13T09:05:00+00:00",
    ancestors: ["PTR-DEMO"],
    acl_groups: [],
    body: `
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
`,
  },
];

export const JIRA_SOURCE: JiraFixture[] = [
  {
    key: "PTR-401",
    url: issue("PTR-401"),
    fields: {
      summary: "Intraday PSR limit amendment",
      status: "To Do",
      issuetype: "Story",
      project: "PTR",
      reporter: "d.mercer",
      created: "2026-07-06T09:12:00+00:00",
      updated: "2026-07-28T15:44:00+00:00",
      description: `
A counterparty limit change made today only takes effect tomorrow, and that
causes us two problems. Collateral a client posts during the day sits there doing
nothing until the overnight cycle, so a counterparty who funded at nine in the
morning is still trading against yesterday's number and rings the desk to say so.
And when credit deteriorates during the day — a downgrade, a name in the news, a
margin call that does not turn up — Risk Ops has no mechanism to bring a line
down before the next business day. Both directions need to be possible on the
day.

Should cover both increases and decreases.
`,
      // The paste instructions tell the human to set these three in Jira, so the
      // fixtures carry them as well — otherwise PTR-401 has three outbound edges
      // live and none offline. Jira shows a relates-to on both issues, which is
      // why PTR-392, PTR-415 and PTR-420 each carry the reciprocal link.
      issue_links: [
        { type: "relates to", key: "PTR-392" },
        { type: "relates to", key: "PTR-415" },
        { type: "relates to", key: "PTR-420" },
      ],
      comments: [
        {
          author: "d.mercer",
          body: "The October collateral cycle is the case I actually care about — is that in scope here, or are we only talking about the ordinary daily posting? Please don't scope it out without speaking to me first.",
        },
      ],
    },
  },
  {
    key: "PTR-388",
    url: issue("PTR-388"),
    fields: {
      summary: "Credit check rejected valid orders after psr-limits restart",
      status: "Done",
      issuetype: "Bug",
      project: "PTR",
      reporter: "s.iyer",
      created: "2025-03-04T07:55:00+00:00",
      updated: "2025-03-19T16:10:00+00:00",
      description: `
psr-limits was restarted on Tuesday morning during a patching window. For about
ninety seconds afterwards ptc-gateway rejected every order that needed a credit
check — a little over 4,100 orders across two XDEM sessions — with a
credit-unavailable reason code. Clients noticed and the desk had to explain it.

Root cause is that the gateways came up holding nothing and psr-limits had not
finished loading, so the check could not be evaluated at all.
`,
      comments: [
        {
          author: "s.iyer",
          body: "For the record, the rejections were correct. The market access controls page is explicit that a pre-trade control which cannot be evaluated must reject the order, and that is exactly what happened. The defect is that we restarted into an empty snapshot in the first place. Fix is warm-up: psr-limits loads and publishes a full set before it accepts traffic, and ptc-gateway will not open a venue session until it holds a snapshot. We are not relaxing the check, and I would rather nobody proposed it again.",
        },
        {
          author: "n.okafor",
          body: "Regression case added — restart psr-limits under load and assert the gateway does not open a session early. Passing on the release candidate.",
        },
      ],
    },
  },
  {
    key: "PTR-392",
    url: issue("PTR-392"),
    fields: {
      summary: "Add maker-checker to credit-admin limit changes",
      status: "Done",
      issuetype: "Story",
      project: "PTR",
      reporter: "d.mercer",
      created: "2025-03-20T10:05:00+00:00",
      updated: "2025-06-11T13:20:00+00:00",
      description: `
A limit change in credit-admin can currently be made and take effect on the
authority of one Risk Ops user. Audit have asked for maker-checker: the user who
raises an amendment must not be the user who approves it, and credit-admin should
enforce that itself rather than leaving it to procedure and a runbook.
`,
      issue_links: [{ type: "relates to", key: "PTR-401" }],
      comments: [
        {
          author: "n.okafor",
          body: "Tested in UAT with two Risk Ops accounts. d.mercer raised the amendment and was refused when trying to approve it; s.iyer approved the same amendment from the second account and it went through to psr-limits. Also confirmed that granting both roles to a single user does not get round the check.",
        },
        {
          author: "d.mercer",
          body: "Runbook updated. Worth saying out loud that this means one person alone on shift cannot move a limit at all.",
        },
      ],
    },
  },
  {
    key: "PTR-415",
    url: issue("PTR-415"),
    fields: {
      summary: "psr-cache staleness alerting",
      status: "In Progress",
      issuetype: "Task",
      project: "PTR",
      reporter: "s.iyer",
      created: "2026-02-13T09:30:00+00:00",
      updated: "2026-07-20T11:15:00+00:00",
      description: `
Nothing tells us when a gateway has stopped receiving snapshot publishes. Each
record already carries its publish timestamp, so a gateway can work out the age
of what it is holding; we want that exported as a metric and alerted on.
Threshold agreed at 1s — if a gateway's view is more than a second old we want to
know about it well before it turns into a rejection. Design context is on the PSR
Cache Refresh Design page.
`,
      issue_links: [{ type: "relates to", key: "PTR-401" }],
      comments: [
        {
          author: "s.iyer",
          body: "Metric is out in the current gateway build. Alert rule still to do, and we have not agreed who it pages — Risk Ops or the platform on-call. d.mercer was going to come back on that.",
        },
      ],
    },
  },
  {
    key: "PTR-420",
    url: issue("PTR-420"),
    fields: {
      summary: "Decide in-flight order treatment on limit reduction",
      status: "Open",
      issuetype: "Task",
      project: "PTR",
      reporter: "s.iyer",
      created: "2026-07-14T08:20:00+00:00",
      updated: "2026-07-24T09:00:00+00:00",
      description: `
When a counterparty limit is reduced, we have no agreed answer for orders that
are already working at the venue. It is written down nowhere, and today's
behaviour is whatever the code happens to do rather than anything anyone chose.
This wants a decision from risk and compliance together — it is not engineering's
to make. Blocking question for PTR-401.
`,
      issue_links: [{ type: "relates to", key: "PTR-401" }],
      comments: [
        {
          author: "s.iyer",
          body: "Raised at the risk forum, no decision yet. I will carry it again next month.",
        },
      ],
    },
  },
];
