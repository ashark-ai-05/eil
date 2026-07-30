# PTR-DEMO service code — synthetic

> **SYNTHETIC DEMO CONTENT.** Illustrative only, written for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

This is **demo corpus, not project code.** It exists to be indexed.

It is deliberately outside `tsconfig.json`'s `include`, outside `biome.json`'s
file globs and outside the vitest test glob, so nothing here is compiled,
linted or run. It is valid TypeScript because a corpus of implausible code
would not survive an engineer reading it over your shoulder.

## Why it exists

The demo's opening question —

> Why does ptc-gateway reject an order when it cannot complete the credit check?

— has no complete answer unless code, tickets and wiki pages are all indexed:

| Source | Contribution |
|---|---|
| Confluence `ptrd-4` | The obligation. A control that cannot be evaluated has not passed. |
| Jira `PTR-388` | It happened: ~4,100 orders rejected with `credit-unavailable` after a psr-limits restart. |
| `ptc-gateway/src/creditCheck.ts` | The branch that does it. |

A second three-source question is held in reserve: maker-checker on limit
amendments, which is `ptrd-5` + `PTR-392` + `credit-admin/src/amendment.ts`.

## The services

These are the four names the Confluence pages and Jira tickets already use.

| Path | What it is |
|---|---|
| `ptc-gateway/` | The only component in the synchronous order path. Evaluates the control set, then forwards or rejects. |
| `psr-limits/` | Computes presettlement exposure and publishes a snapshot per counterparty. |
| `credit-admin/` | Where Risk Ops raises and approves limit amendments. Enforces maker-checker itself. |

## How it gets indexed

```sh
eil ingest repo . --subpath demo/repo --name ptr-services --include '**/*.ts' --include '**/*.md'
```

That clones this checkout into `.eil-repos/` and indexes this subtree. Nothing
goes to the network.

**Cloning indexes committed state.** Edits here are not searchable until they
are committed. That is also what makes the demo's second ingest run print
`up to date (<sha>)` instead of re-reading anything.
