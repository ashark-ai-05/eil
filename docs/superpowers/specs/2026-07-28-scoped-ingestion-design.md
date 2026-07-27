# Scoped Confluence/Jira Ingestion — Design (Phase 1)

**Date:** 2026-07-28
**Status:** Approved decisions; autonomous build authorized by user
**Follow-on:** Repo ingestion ("huge repos") is a separate subsystem — its own spec (Phase 2).

## Problem

Today `eil ingest confluence` / `eil ingest jira` (live) sync the **entire**
instance from a single global cursor. Users need to ingest *selectively*: one
or more Confluence pages, one or more spaces, one or more Jira issues, or one or
more projects — without dragging in the whole instance, and with correct
incremental re-sync per selection.

## Granularity model (the core design question)

Selection operates on a ladder from coarse to fine. Each grain exists because a
real workflow needs exactly it:

**Confluence**
| Grain | Selector | Why it exists |
|---|---|---|
| Instance | (no flag) | Full mirror — unchanged current behavior |
| Space(s) | `--space ENG,OPS` | "Index my team's space(s)" — the common case |
| Page subtree | `--page ID --with-descendants` | "This runbook and everything under it" |
| Page(s) | `--page ID1,ID2` | "Just these exact pages" |
| Arbitrary | `--query '<CQL>'` | Everything else the query engine supports (by label, date, author) |

**Jira**
| Grain | Selector | Why it exists |
|---|---|---|
| Instance | (no flag) | Full mirror — unchanged |
| Project(s) | `--project PAY,CHK` | "Index these projects" — the common case |
| Issue(s) | `--issue PAY-981,PAY-42` | "Just these exact tickets" |
| Arbitrary | `--query '<JQL>'` | by label/assignee/sprint/epic/date — engine's full power |

**Design principle:** provide *named convenience selectors* for the common
grains (they build the CQL/JQL for you) plus a *raw `--query` escape hatch* for
the long tail. The connectors already speak CQL/JQL, so the escape hatch is
nearly free.

## Decisions (locked with user)

1. **Convenience flags + `--query` escape hatch** (not fixed-only, not raw-only).
2. **Per-scope cursors:** each atomic scope tracks its own incremental cursor.
3. **One selector family per run** — keeps semantics and cursor bookkeeping
   unambiguous; the escape hatch covers unions.

## CLI surface

```
eil ingest confluence [--space K[,K2]] [--page ID[,ID2] [--with-descendants]] \
                      [--query '<CQL>'] [--reconcile] [--tenant t] [--fixture path]

eil ingest jira       [--project P[,P2]] [--issue K[,K2]] \
                      [--query '<JQL>'] [--reconcile] [--tenant t] [--fixture path]
```

Rules (validated before any network call, with a clear one-line error):
- **At most one selector family per run.** confluence: one of {space, page, query}.
  jira: one of {project, issue, query}. Two families → error.
- **No selector → current full-instance behavior** (byte-for-byte unchanged).
- `--with-descendants` is only valid with `--page` (Confluence). Otherwise error.
- `--fixture` bypasses live sync and ignores selectors; combining `--fixture`
  with a selector is an error (avoids silent surprise).
- **`--reconcile` requires full-instance scope** (no selector). Combining
  `--reconcile` with a selector is an error — see "Scoped reconcile is unsafe".

## Scope abstraction

New module `ts/connectors/scope.ts`. A `Scope` is one atomic unit of work with
its own cursor:

```ts
export type Scope =
  | { kind: "all" }
  | { kind: "space"; key: string }            // one space
  | { kind: "project"; key: string }          // one project
  | { kind: "pages"; ids: string[]; withDescendants: boolean }  // explicit ids, one batch
  | { kind: "issues"; keys: string[] }        // explicit keys, one batch
  | { kind: "query"; q: string };             // raw CQL/JQL predicate
```

Multi-value convenience flags **expand to multiple atomic scopes**, each synced
independently with its own cursor:
- `--space ENG,OPS` → `[{space:ENG}, {space:OPS}]`
- `--project PAY,CHK` → `[{project:PAY}, {project:CHK}]`
- `--page 1,2` → one `{pages:[1,2]}` scope (explicit ids are a single batch)
- `--issue A,B` → one `{issues:[A,B]}` scope
- `--query '…'` → one `{query:'…'}` scope

`scope.ts` exposes pure functions (all unit-tested, no I/O):
- `parseConfluenceScopes(opts): Scope[]` / `parseJiraScopes(opts): Scope[]` —
  build scopes from parsed CLI options; throw on the rule violations above.
- `cursorKey(source, scope): string | null` — the sync_cursors key, or `null`
  for explicit-id / no-cursor scopes:
  - `{all}` → `"confluence"` / `"jira"` (unchanged — preserves existing cursor)
  - `{space:ENG}` → `"confluence:space:ENG"`
  - `{project:PAY}` → `"jira:project:PAY"`
  - `{query:q}` → `"confluence:query:<sha1(q).slice(0,12)>"` (stable per query text)
  - `{pages}` / `{issues}` → `null` (explicit fetch; always run, hash-gated)
- `predicate(scope): string | null` — the CQL/JQL fragment ANDed into the query,
  or `null` for `{all}` / explicit-id scopes:
  - `{space:ENG}` → `space = "ENG"`
  - `{project:PAY}` → `project = "PAY"`
  - `{query:q}` → `(q)` (wrapped; user supplies a predicate, not an order-by)

## Cursor model

**No migration needed.** `sync_cursors.source` is `text PRIMARY KEY`; a scope
key like `confluence:space:ENG` is just another string key. `getCursor` /
`setCursor` already take a `string`. `{all}` maps to the existing `confluence` /
`jira` keys, so full-instance sync is untouched.

`documents.source` stays the connector name (`confluence`/`jira`) — the scope
lives only in the cursor key, so drift/metrics/reconcile that key on
`documents.source` are unaffected.

## Connector changes

Generalize the existing generators to take an optional scope predicate; the
default (no predicate, no scope) reproduces today's query exactly.

**`ts/connectors/confluence.ts`**
```ts
// updatedSince(cursor, scope?) composes: type=page [and <scope>] [and lastmodified >= "<cur>"] order by lastmodified asc
async *updatedSince(cursor: string | null, scope?: string): AsyncGenerator<ConfluencePage>
// scoped reconcile listing
async listIds(scope?: string): Promise<string[]>
// page subtree for --with-descendants (CQL: ancestor = <id>), paged
async *descendants(pageId: string): AsyncGenerator<ConfluencePage>
// getPage(id) already exists — used for explicit --page
```
The composed CQL for `{all}` with no cursor MUST equal the current
`type=page order by lastmodified asc` (golden-preserving).

**`ts/connectors/jira.ts`**
```ts
// updatedSince(cursor, scope?) composes: [<scope> and] [updated >= "<cur>" and] order by updated asc
async *updatedSince(cursor: string | null, scope?: string): AsyncGenerator<JiraIssue>
async listIds(scope?: string): Promise<string[]>
// getIssue(key) already exists — used for explicit --issue
```
For `{all}` no cursor, JQL MUST equal the current `order by updated asc`.

## CLI orchestration (`ts/cli.ts`)

For a live run, `parse*Scopes(opts)` yields `Scope[]`. For each scope:
- **Cursor scopes** (`all`/`space`/`project`/`query`): `key = cursorKey(...)`,
  `cursor = getCursor(key)`, stream `updatedSince(cursor, predicate(scope))`,
  and drive the existing `ingestDocs` passing `key` as the cursor source so the
  **scoped** cursor advances (reusing the current failure-holds-cursor logic).
- **Explicit scopes** (`pages`/`issues`): fetch each id via `getPage`/`getIssue`
  (and, for `--with-descendants`, also stream `descendants(id)`); ingest with
  **no cursor** (reuse `ingestDocs` with `cursorOf` undefined → no `setCursor`).
- Log each scope's boundary (`scope confluence:space:ENG from cursor …`).

`--reconcile` (full-instance only) is unchanged: after the `{all}` sync,
`runReconcile` with the full `listIds()`.

### Scoped reconcile is unsafe — why it's excluded

`reconcile` does `DELETE FROM documents WHERE source=$1 AND NOT (id = ANY(present))`.
`documents` has **no queryable space/project column** (space is buried in the
`hierarchy` jsonb breadcrumb). A scoped listing (e.g. only ENG pages) passed to
`reconcile` would tombstone every non-ENG confluence doc. Rather than ship a
footgun, v1 restricts `--reconcile` to full-instance sync and errors otherwise.
(A safe scoped reconcile — add an indexed `space`/`project` column and a scoped
DELETE — is deferred to a later iteration if needed.)

## Testing strategy

Mirrors existing patterns (`connectors.test.ts` mock-fetcher asserts on the
built CQL/JQL; pure-function unit tests; fixtures for the ingest path).

- **`scope.ts` (pure, CI):** flag → `Scope[]` for every grain; rejects two
  families, `--with-descendants` without `--page`, `--reconcile`+selector,
  `--fixture`+selector; `cursorKey` mapping incl. stable query hash and `null`
  for explicit scopes; `predicate` fragments.
- **Connectors (mock fetcher, CI):** for `{all}` the CQL/JQL is byte-identical
  to today (regression guard); `--space`/`--project`/`--query` inject the right
  predicate; `descendants` uses `ancestor = <id>`; scoped `listIds` carries the
  predicate; explicit `getPage`/`getIssue` batching.
- **CLI orchestration (CI, against a DB or with injected connectors):** a scoped
  ingest reads and writes the **scoped** cursor key (not the global one);
  `--space A,B` produces two independent cursor advances; `--reconcile`+selector
  and the other rule violations exit non-zero with the documented message.
- **Fixtures still work** unchanged (`--fixture` path untouched).

## Documentation

README "Live connectors" section: a "Selective ingestion (granularity)" table
mirroring the ladder above, the one-selector-family rule, the per-scope cursor
note, and the `--reconcile` full-instance restriction. Update the Status list.

## Files touched

- Create `ts/connectors/scope.ts` — Scope type, `parse*Scopes`, `cursorKey`, `predicate`.
- Modify `ts/connectors/confluence.ts` — scope-aware `updatedSince`/`listIds`, new `descendants`.
- Modify `ts/connectors/jira.ts` — scope-aware `updatedSince`/`listIds`.
- Modify `ts/cli.ts` — scope parsing + per-scope orchestration in the confluence/jira ingest actions.
- Create `ts/tests/scope.test.ts` — pure scope tests.
- Modify `ts/tests/connectors.test.ts` — scoped CQL/JQL + descendants + regression.
- Modify `ts/tests/ingest.test.ts` (or a new cli-scoped test) — per-scope cursor + rule errors.
- Modify `README.md` — granularity docs + Status.

## Non-Goals (Phase 1)

- Repo/code ingestion of huge repos (separate Phase 2 spec).
- Safe scoped reconcile (needs a schema column; deferred).
- Confluence blogposts/attachments as first-class content: Phase-1 always filters
  `type=page`, so `--query` is a **page predicate** (label/date/author/ancestor/
  space combos — powerful, but page-scoped). Non-page content would need lifting
  the `type=page` filter (deferred). Jira `--query` has no such restriction (JQL
  is unrestricted; boards/sprints/epics are reachable via `--query`).
- Combining selector families in one run (use `--query`).
