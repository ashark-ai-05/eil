# Scoped Confluence/Jira Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users ingest selectively — one or more Confluence pages/spaces (optionally a page subtree) or Jira issues/projects, plus a raw `--query` escape hatch — each selection incrementally re-syncable via its own cursor.

**Architecture:** A pure `ts/connectors/scope.ts` turns CLI flags into `Scope[]` and derives per-scope cursor keys + CQL/JQL predicates. The connectors gain a scope-aware `updatedSince(cursor, scope?)` / `listIds(scope?)` (byte-identical to today when no scope). `ingestDocs`/`runReconcile` move out of `cli.ts` into `ts/ingest/pipeline.ts` alongside new per-scope orchestration helpers, so the cursor behavior is unit-testable. `cli.ts` wires flags → scopes → orchestration.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), commander, node:crypto (sha1), pg/PGlite, vitest, biome.

## Global Constraints

- Node 22+, ESM, strict `tsc`. Relative import specifiers end in `.js`. No new deps.
- **Regression-preserving:** with no scope, the built CQL is exactly `type=page order by lastmodified asc` (Confluence) / `type=page and lastmodified >= "<cur>" order by lastmodified asc` when a cursor is present; JQL is exactly `order by updated asc` / `updated >= "<cur>" order by updated asc`. Existing connector tests must stay green unchanged.
- **One selector family per run:** confluence ∈ {space, page, query}; jira ∈ {project, issue, query}. Two → error.
- `--with-descendants` valid only with `--page`. `--fixture` cannot combine with a selector. `--reconcile` is **full-instance only** (selector + `--reconcile` → error) because scoped reconcile would tombstone out-of-scope docs.
- **Per-scope cursor keys** (no migration; reuse `sync_cursors.source`): `{all}`→`confluence`/`jira`; `{space:K}`→`confluence:space:K`; `{project:K}`→`jira:project:K`; `{query:q}`→`<source>:query:<sha1(q)[:12]>`; `{pages}`/`{issues}`→`null` (explicit fetch, no cursor).
- `documents.source` stays `confluence`/`jira` (scope lives only in the cursor key).
- Convenience selector values are validated: space/project keys `^[A-Za-z0-9_-]+$`, page ids `^\d+$`, issue keys `^[A-Za-z][A-Za-z0-9]*-\d+$`. `--query` is raw (user owns it), not validated.

## File Structure

- Create `ts/connectors/scope.ts` — `Scope`, `parseConfluenceScopes`, `parseJiraScopes`, `cursorKey`, `predicate`, value validation.
- Modify `ts/connectors/confluence.ts` — scope-aware `updatedSince`/`listIds`, new `descendants`.
- Modify `ts/connectors/jira.ts` — scope-aware `updatedSince`/`listIds`.
- Create `ts/ingest/pipeline.ts` — moved `ingestDocs`/`runReconcile` + new `ingestConfluenceScope`/`ingestJiraScope`.
- Modify `ts/cli.ts` — import pipeline helpers; add flags; parse scopes; per-scope orchestration.
- Create `ts/tests/scope.test.ts`; modify `ts/tests/connectors.test.ts`; create `ts/tests/pipeline.test.ts`.
- Modify `README.md`.

---

### Task 1: `scope.ts` — flags → scopes, cursor keys, predicates (pure)

**Files:**
- Create: `ts/connectors/scope.ts`
- Test: `ts/tests/scope.test.ts`

**Interfaces:**
- Produces: `type Scope`; `parseConfluenceScopes(opts): Scope[]`; `parseJiraScopes(opts): Scope[]`; `cursorKey(source: string, scope: Scope): string | null`; `predicate(scope: Scope): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/scope.test.ts
import { describe, expect, it } from "vitest";
import {
  cursorKey,
  parseConfluenceScopes,
  parseJiraScopes,
  predicate,
  type Scope,
} from "../connectors/scope.js";

describe("parseConfluenceScopes", () => {
  it("defaults to the whole instance", () => {
    expect(parseConfluenceScopes({})).toEqual([{ kind: "all" }]);
  });
  it("expands --space to one scope per key", () => {
    expect(parseConfluenceScopes({ space: "ENG, OPS" })).toEqual([
      { kind: "space", key: "ENG" },
      { kind: "space", key: "OPS" },
    ]);
  });
  it("batches --page ids into one scope, honoring --with-descendants", () => {
    expect(parseConfluenceScopes({ page: "12345,678", withDescendants: true })).toEqual([
      { kind: "pages", ids: ["12345", "678"], withDescendants: true },
    ]);
  });
  it("passes --query through raw", () => {
    expect(parseConfluenceScopes({ query: "label = incident" })).toEqual([
      { kind: "query", q: "label = incident" },
    ]);
  });
  it("rejects two selector families", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", page: "1" })).toThrow(/at most one/);
  });
  it("rejects --with-descendants without --page", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", withDescendants: true })).toThrow(
      /--with-descendants/,
    );
  });
  it("rejects --reconcile with a selector", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", reconcile: true })).toThrow(/full-instance/);
  });
  it("rejects --fixture with a selector", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", fixture: "f.json" })).toThrow(/fixture/);
  });
  it("rejects an invalid space key", () => {
    expect(() => parseConfluenceScopes({ space: 'ENG" or x' })).toThrow(/invalid/i);
  });
});

describe("parseJiraScopes", () => {
  it("expands --project per key and batches --issue", () => {
    expect(parseJiraScopes({ project: "PAY,CHK" })).toEqual([
      { kind: "project", key: "PAY" },
      { kind: "project", key: "CHK" },
    ]);
    expect(parseJiraScopes({ issue: "PAY-981,PAY-42" })).toEqual([
      { kind: "issues", keys: ["PAY-981", "PAY-42"] },
    ]);
  });
  it("rejects an invalid issue key", () => {
    expect(() => parseJiraScopes({ issue: "not a key" })).toThrow(/invalid/i);
  });
});

describe("cursorKey", () => {
  it("maps scopes to stable keys; explicit scopes have none", () => {
    expect(cursorKey("confluence", { kind: "all" })).toBe("confluence");
    expect(cursorKey("confluence", { kind: "space", key: "ENG" })).toBe("confluence:space:ENG");
    expect(cursorKey("jira", { kind: "project", key: "PAY" })).toBe("jira:project:PAY");
    expect(cursorKey("confluence", { kind: "pages", ids: ["1"], withDescendants: false })).toBeNull();
    expect(cursorKey("jira", { kind: "issues", keys: ["PAY-1"] })).toBeNull();
    const q: Scope = { kind: "query", q: "label = incident" };
    const k = cursorKey("confluence", q)!;
    expect(k).toMatch(/^confluence:query:[0-9a-f]{12}$/);
    expect(cursorKey("confluence", q)).toBe(k); // stable
  });
});

describe("predicate", () => {
  it("builds CQL/JQL fragments; none for all/explicit", () => {
    expect(predicate({ kind: "all" })).toBeNull();
    expect(predicate({ kind: "space", key: "ENG" })).toBe('space = "ENG"');
    expect(predicate({ kind: "project", key: "PAY" })).toBe('project = "PAY"');
    expect(predicate({ kind: "query", q: "label = x" })).toBe("(label = x)");
    expect(predicate({ kind: "pages", ids: ["1"], withDescendants: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/scope.test.ts`
Expected: FAIL — cannot resolve `../connectors/scope.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ts/connectors/scope.ts
/**
 * Selection granularity for live ingestion. Pure: turns CLI flags into atomic
 * Scopes, each with its own incremental cursor key and CQL/JQL predicate.
 * One selector family per run; --query is a raw escape hatch. See
 * docs/superpowers/specs/2026-07-28-scoped-ingestion-design.md.
 */

import { createHash } from "node:crypto";

export type Scope =
  | { kind: "all" }
  | { kind: "space"; key: string }
  | { kind: "project"; key: string }
  | { kind: "pages"; ids: string[]; withDescendants: boolean }
  | { kind: "issues"; keys: string[] }
  | { kind: "query"; q: string };

function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validated(values: string[], re: RegExp, what: string): string[] {
  for (const v of values) {
    if (!re.test(v)) throw new Error(`invalid ${what}: ${v}`);
  }
  return values;
}

const SPACE_KEY = /^[A-Za-z0-9_-]+$/;
const PAGE_ID = /^\d+$/;
const PROJECT_KEY = /^[A-Za-z0-9_-]+$/;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export interface ConfluenceScopeOpts {
  space?: string;
  page?: string;
  query?: string;
  withDescendants?: boolean;
  reconcile?: boolean;
  fixture?: string;
}

export function parseConfluenceScopes(opts: ConfluenceScopeOpts): Scope[] {
  const families = [opts.space, opts.page, opts.query].filter((v) => v != null).length;
  if (families > 1) throw new Error("choose at most one of --space, --page, --query");
  if (opts.withDescendants && opts.page == null)
    throw new Error("--with-descendants requires --page");
  if (opts.reconcile && families > 0)
    throw new Error("--reconcile is only supported for full-instance sync (drop the selector)");
  if (opts.fixture && families > 0) throw new Error("--fixture cannot be combined with a selector");

  if (opts.space != null)
    return validated(splitList(opts.space), SPACE_KEY, "space key").map((key) => ({
      kind: "space",
      key,
    }));
  if (opts.page != null)
    return [
      {
        kind: "pages",
        ids: validated(splitList(opts.page), PAGE_ID, "page id"),
        withDescendants: !!opts.withDescendants,
      },
    ];
  if (opts.query != null) return [{ kind: "query", q: opts.query }];
  return [{ kind: "all" }];
}

export interface JiraScopeOpts {
  project?: string;
  issue?: string;
  query?: string;
  reconcile?: boolean;
  fixture?: string;
}

export function parseJiraScopes(opts: JiraScopeOpts): Scope[] {
  const families = [opts.project, opts.issue, opts.query].filter((v) => v != null).length;
  if (families > 1) throw new Error("choose at most one of --project, --issue, --query");
  if (opts.reconcile && families > 0)
    throw new Error("--reconcile is only supported for full-instance sync (drop the selector)");
  if (opts.fixture && families > 0) throw new Error("--fixture cannot be combined with a selector");

  if (opts.project != null)
    return validated(splitList(opts.project), PROJECT_KEY, "project key").map((key) => ({
      kind: "project",
      key,
    }));
  if (opts.issue != null)
    return [{ kind: "issues", keys: validated(splitList(opts.issue), ISSUE_KEY, "issue key") }];
  if (opts.query != null) return [{ kind: "query", q: opts.query }];
  return [{ kind: "all" }];
}

export function cursorKey(source: string, scope: Scope): string | null {
  switch (scope.kind) {
    case "all":
      return source;
    case "space":
      return `${source}:space:${scope.key}`;
    case "project":
      return `${source}:project:${scope.key}`;
    case "query":
      return `${source}:query:${createHash("sha1").update(scope.q).digest("hex").slice(0, 12)}`;
    case "pages":
    case "issues":
      return null;
  }
}

export function predicate(scope: Scope): string | null {
  switch (scope.kind) {
    case "space":
      return `space = "${scope.key}"`;
    case "project":
      return `project = "${scope.key}"`;
    case "query":
      return `(${scope.q})`;
    case "all":
    case "pages":
    case "issues":
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ts/connectors/scope.ts ts/tests/scope.test.ts
git commit -m "scope: flags -> scopes, per-scope cursor keys + CQL/JQL predicates (pure)"
```

---

### Task 2: Confluence connector — scope-aware queries + descendants

**Files:**
- Modify: `ts/connectors/confluence.ts`
- Test: `ts/tests/connectors.test.ts`

**Interfaces:**
- Consumes: nothing new (predicate strings are passed in by the caller).
- Produces: `updatedSince(cursor: string | null, scope?: string)`; `listIds(scope?: string)`; `descendants(pageId: string): AsyncGenerator<ConfluencePage>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/connectors.test.ts, inside/after the existing confluence describe
import { PAGE_SIZE } from "../connectors/confluence.js"; // if not already imported

describe("confluence scoped", () => {
  const apiPage = (id: string) => ({
    id,
    title: `p${id}`,
    space: { name: "S" },
    ancestors: [],
    version: { when: "2026-06-03T10:00:00+00:00", by: { displayName: "a" } },
    _links: { webui: `/pages/${id}` },
    body: { storage: { value: "<p>x</p>" } },
  });

  it("with no scope builds the exact legacy CQL (regression)", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [], size: 0 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null)) { /* drain */ }
    expect(seen).toBe("type=page order by lastmodified asc");
  });

  it("injects a space predicate", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [], size: 0 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null, 'space = "ENG"')) { /* drain */ }
    expect(seen).toBe('type=page and space = "ENG" order by lastmodified asc');
  });

  it("descendants queries ancestor = id", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [apiPage("9")], size: 1 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    const out = [];
    for await (const p of c.descendants("100")) out.push(p);
    expect(seen).toBe("ancestor = 100 order by lastmodified asc");
    expect(out).toHaveLength(1);
  });

  it("scoped listIds carries the predicate", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [], size: 0 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    await c.listIds('space = "ENG"');
    expect(seen).toBe('type=page and space = "ENG" order by id asc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/connectors.test.ts`
Expected: FAIL — `updatedSince` ignores the 2nd arg; `descendants` undefined.

- [ ] **Step 3: Write minimal implementation**

In `ts/connectors/confluence.ts`, replace `updatedSince` and `listIds`, and add `descendants`:

```ts
  async *updatedSince(cursor: string | null, scope?: string): AsyncGenerator<ConfluencePage> {
    const clauses = ["type=page"];
    if (scope) clauses.push(scope);
    if (cursor) clauses.push(`lastmodified >= "${cqlTs(cursor)}"`);
    const cql = `${clauses.join(" and ")} order by lastmodified asc`;
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/content/search", {
        cql,
        expand: "body.storage,ancestors,version,space",
        limit: PAGE_SIZE,
        start,
      });
      for (const page of data.results ?? []) yield this.toPageDict(page);
      if ((data.size ?? 0) < PAGE_SIZE) return;
      start += PAGE_SIZE;
    }
  }

  /** Page subtree for --with-descendants: every page under `pageId`, any depth. */
  async *descendants(pageId: string): AsyncGenerator<ConfluencePage> {
    const cql = `ancestor = ${pageId} order by lastmodified asc`;
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/content/search", {
        cql,
        expand: "body.storage,ancestors,version,space",
        limit: PAGE_SIZE,
        start,
      });
      for (const page of data.results ?? []) yield this.toPageDict(page);
      if ((data.size ?? 0) < PAGE_SIZE) return;
      start += PAGE_SIZE;
    }
  }

  async listIds(scope?: string): Promise<string[]> {
    const clauses = ["type=page"];
    if (scope) clauses.push(scope);
    const cql = `${clauses.join(" and ")} order by id asc`;
    const ids: string[] = [];
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/content/search", {
        cql,
        limit: PAGE_SIZE,
        start,
      });
      for (const page of data.results ?? []) ids.push(`confluence:page:${page.id}`);
      if ((data.size ?? 0) < PAGE_SIZE) return ids;
      start += PAGE_SIZE;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run ts/tests/connectors.test.ts`
Expected: PASS — including the pre-existing confluence tests (regression guard).

- [ ] **Step 5: Commit**

```bash
git add ts/connectors/confluence.ts ts/tests/connectors.test.ts
git commit -m "confluence: scope-aware updatedSince/listIds + descendants (subtree)"
```

---

### Task 3: Jira connector — scope-aware queries

**Files:**
- Modify: `ts/connectors/jira.ts`
- Test: `ts/tests/connectors.test.ts`

**Interfaces:**
- Produces: `updatedSince(cursor: string | null, scope?: string)`; `listIds(scope?: string)`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/connectors.test.ts
describe("jira scoped", () => {
  it("with no scope builds the exact legacy JQL (regression)", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("jql") ?? "";
      return jsonResponse({ issues: [], total: 0 });
    };
    const c = new JiraClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null)) { /* drain */ }
    expect(seen).toBe("order by updated asc");
  });

  it("injects a project predicate and composes with the cursor", async () => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (url) => {
      seen.push(new URL(String(url)).searchParams.get("jql") ?? "");
      return jsonResponse({ issues: [], total: 0 });
    };
    const c = new JiraClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null, 'project = "PAY"')) { /* drain */ }
    for await (const _ of c.updatedSince("2026-06-01T00:00:00+00:00", 'project = "PAY"')) { /* drain */ }
    expect(seen[0]).toBe('project = "PAY" order by updated asc');
    expect(seen[1]).toBe('project = "PAY" and updated >= "2026-06-01 00:00" order by updated asc');
  });

  it("scoped listIds carries the predicate", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("jql") ?? "";
      return jsonResponse({ issues: [], total: 0 });
    };
    const c = new JiraClient("https://x", "t", fetcher);
    await c.listIds('project = "PAY"');
    expect(seen).toBe('project = "PAY" order by key asc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/connectors.test.ts`
Expected: FAIL — `updatedSince`/`listIds` ignore the scope arg.

- [ ] **Step 3: Write minimal implementation**

In `ts/connectors/jira.ts`, replace `updatedSince` and `listIds`:

```ts
  async *updatedSince(cursor: string | null, scope?: string): AsyncGenerator<JiraIssue> {
    const clauses: string[] = [];
    if (scope) clauses.push(scope);
    if (cursor) clauses.push(`updated >= "${cqlTs(cursor)}"`);
    const where = clauses.length > 0 ? `${clauses.join(" and ")} ` : "";
    const jql = `${where}order by updated asc`;
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/2/search", {
        jql,
        fields: FIELDS,
        maxResults: PAGE_SIZE,
        startAt: start,
      });
      const issues = data.issues ?? [];
      for (const issue of issues) yield this.toIssueDict(issue);
      start += issues.length;
      if (start >= (data.total ?? 0) || issues.length === 0) return;
    }
  }

  async listIds(scope?: string): Promise<string[]> {
    const where = scope ? `${scope} ` : "";
    const jql = `${where}order by key asc`;
    const ids: string[] = [];
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/2/search", {
        jql,
        fields: "key",
        maxResults: PAGE_SIZE,
        startAt: start,
      });
      const issues = data.issues ?? [];
      for (const issue of issues) ids.push(`jira:issue:${issue.key}`);
      start += issues.length;
      if (start >= (data.total ?? 0) || issues.length === 0) return ids;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run ts/tests/connectors.test.ts`
Expected: PASS (incl. pre-existing jira tests).

- [ ] **Step 5: Commit**

```bash
git add ts/connectors/jira.ts ts/tests/connectors.test.ts
git commit -m "jira: scope-aware updatedSince/listIds"
```

---

### Task 4: Extract ingest pipeline out of cli.ts (behavior-preserving)

**Files:**
- Create: `ts/ingest/pipeline.ts`
- Modify: `ts/cli.ts`
- Test: existing suite must stay green (no new test; this is a pure move).

**Interfaces:**
- Produces: `ingestDocs(source: string, docs, cursorOf?): Promise<void>`; `runReconcile(source: string, listIds: () => Promise<string[]>, tenant: string): Promise<void>` — exported from `ts/ingest/pipeline.ts` with identical behavior to the current cli.ts versions.
- Consumes (later tasks): the two functions above.

- [ ] **Step 1: Create the module by moving the code verbatim**

Create `ts/ingest/pipeline.ts` and move `IngestOutcome`, `ingestDocs`, and `runReconcile` there **unchanged** from `ts/cli.ts`. Add the imports they need at the top of the new file:

```ts
// ts/ingest/pipeline.ts
/** Shared ingest pipeline: per-doc upsert with cursor bookkeeping, and the
 *  full-listing reconcile. Extracted from cli.ts so orchestration is testable. */

import type { CanonicalDoc } from "../contracts/models.js";
import { connect } from "../db.js";

interface IngestOutcome {
  seen: number;
  changed: number;
  failed: number;
  target: string | null;
}

export async function ingestDocs(
  source: string,
  docs: AsyncIterable<CanonicalDoc> | Iterable<CanonicalDoc>,
  cursorOf?: (doc: CanonicalDoc) => string | null,
): Promise<void> {
  const { setCursor, upsertDocument } = await import("../store.js");
  const client = await connect();
  const outcome: IngestOutcome = { seen: 0, changed: 0, failed: 0, target: null };
  let latest: string | null = null;
  let retryFrom: string | null = null;
  try {
    for await (const doc of docs) {
      outcome.seen += 1;
      const value = cursorOf ? cursorOf(doc) : null;
      try {
        if (await upsertDocument(client, doc)) {
          outcome.changed += 1;
          console.log(`  ~ ${doc.id}`);
        }
      } catch (err: any) {
        outcome.failed += 1;
        console.log(`  ! failed (${err.constructor?.name ?? "Error"}): ${err.message}`);
        if (value && (retryFrom === null || value < retryFrom)) retryFrom = value;
        continue;
      }
      if (value && (latest === null || value > latest)) latest = value;
    }
    outcome.target = retryFrom ?? latest;
    if (outcome.target) await setCursor(client, source, outcome.target);
  } finally {
    await client.end();
  }
  let summary = `${outcome.seen} seen, ${outcome.changed} changed`;
  if (outcome.failed > 0) summary += `, ${outcome.failed} FAILED (cursor held at ${outcome.target})`;
  else if (latest) summary += `, cursor -> ${latest}`;
  console.log(summary);
}

export async function runReconcile(
  source: string,
  listIds: () => Promise<string[]>,
  tenant: string,
): Promise<void> {
  console.log(`reconcile: fetching full ${source} id listing...`);
  const present = await listIds();
  const { reconcile } = await import("../store.js");
  const client = await connect();
  try {
    const removed = await reconcile(client, source, present, tenant);
    for (const id of removed) console.log(`  - ${id} (deleted at source)`);
    console.log(`reconcile: ${present.length} present at source, ${removed.length} removed`);
  } finally {
    await client.end();
  }
}
```

- [ ] **Step 2: Update cli.ts to import instead of define**

In `ts/cli.ts`: delete the local `IngestOutcome`, `ingestDocs`, and `runReconcile` definitions. Add near the top imports:

```ts
import { ingestDocs, runReconcile } from "./ingest/pipeline.js";
```
Leave `fixturePayloads` and `liveClient` in cli.ts (they are CLI-specific). Keep the existing `connect`/`migrate` import in cli.ts if still used elsewhere (it is, by `db migrate`/`embedded`). Remove the now-unused `CanonicalDoc` import from cli.ts if nothing else there uses it (check — `ingestDocs`'s signature moved out).

- [ ] **Step 3: Verify the whole suite + a real fixture ingest are unchanged**

Run:
```bash
pnpm typecheck && pnpm lint
EIL_DATABASE_URL=pglite://.eil-t pnpm exec vitest run && rm -rf .eil-t
EIL_DATABASE_URL=pglite://.eil-t2 pnpm -s eil db migrate && \
  EIL_DATABASE_URL=pglite://.eil-t2 pnpm -s eil ingest jira --fixture tests/fixtures/jira_issue.json && \
  rm -rf .eil-t2
```
Expected: typecheck/lint clean; full suite passes exactly as before; the fixture ingest prints `1 seen, 1 changed`.

- [ ] **Step 4: Commit**

```bash
git add ts/ingest/pipeline.ts ts/cli.ts
git commit -m "ingest: extract ingestDocs/runReconcile into ts/ingest/pipeline.ts (no behavior change)"
```

---

### Task 5: Per-scope orchestration helpers + cursor tests

**Files:**
- Modify: `ts/ingest/pipeline.ts`
- Test: `ts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `ingestDocs` (Task 4); `Scope`, `cursorKey`, `predicate` (Task 1); the connector shapes (Tasks 2-3).
- Produces:
  - `interface ConfluenceLike { updatedSince(cursor: string | null, scope?: string): AsyncGenerator<ConfluencePage>; getPage(id: string): Promise<ConfluencePage>; descendants(id: string): AsyncGenerator<ConfluencePage>; }`
  - `interface JiraLike { updatedSince(cursor: string | null, scope?: string): AsyncGenerator<JiraIssue>; getIssue(key: string): Promise<JiraIssue>; }`
  - `ingestConfluenceScope(conf: ConfluenceLike, scope: Scope, tenant: string): Promise<void>`
  - `ingestJiraScope(jira: JiraLike, scope: Scope, tenant: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/pipeline.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfluencePage } from "../ingest/confluence.js";
import { ingestConfluenceScope } from "../ingest/pipeline.js";

// Drive the orchestration against a real (PGlite) DB and a fake connector,
// asserting the SCOPED cursor advances and the global one does not.
const dir = mkdtempSync(join(tmpdir(), "eil-pipeline-"));

beforeAll(async () => {
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  const { connect, migrate } = await import("../db.js");
  const c = await connect();
  await migrate(c);
  await c.end();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const page = (id: string, updated: string): ConfluencePage => ({
  id,
  title: `p${id}`,
  url: null,
  author: "a",
  updated,
  created: null,
  ancestors: ["ENG"],
  acl_groups: [],
  body: `body ${id} ${updated}`,
});

const fakeConf = {
  async *updatedSince(_cursor: string | null, _scope?: string) {
    yield page("100", "2026-06-05T00:00:00+00:00");
  },
  async getPage(id: string) {
    return page(id, "2026-06-06T00:00:00+00:00");
  },
  async *descendants(_id: string) {
    yield page("101", "2026-06-06T00:00:00+00:00");
  },
};

describe("ingestConfluenceScope", () => {
  it("advances the SCOPED cursor, not the global one", async () => {
    await ingestConfluenceScope(fakeConf, { kind: "space", key: "ENG" }, "default");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const c = await connect();
    try {
      expect(await getCursor(c, "confluence:space:ENG")).toBe("2026-06-05T00:00:00+00:00");
      expect(await getCursor(c, "confluence")).toBeNull();
    } finally {
      await c.end();
    }
  });

  it("explicit pages write no cursor and can include descendants", async () => {
    await ingestConfluenceScope(
      fakeConf,
      { kind: "pages", ids: ["100"], withDescendants: true },
      "default",
    );
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const c = await connect();
    try {
      // no cursor key exists for explicit pages
      expect(await getCursor(c, "confluence")).toBeNull();
      // both the page and its descendant were upserted
      const n = await c.query("SELECT count(*)::int AS n FROM documents WHERE id IN ($1,$2)", [
        "confluence:page:100",
        "confluence:page:101",
      ]);
      expect(n.rows[0].n).toBe(2);
    } finally {
      await c.end();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/pipeline.test.ts`
Expected: FAIL — `ingestConfluenceScope` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `ts/ingest/pipeline.ts`:

```ts
import type { ConfluencePage } from "../ingest/confluence.js";
import type { JiraIssue } from "../ingest/jira.js";
import { type Scope, cursorKey, predicate } from "../connectors/scope.js";
import { getCursor } from "../store.js";

export interface ConfluenceLike {
  updatedSince(cursor: string | null, scope?: string): AsyncGenerator<ConfluencePage>;
  getPage(id: string): Promise<ConfluencePage>;
  descendants(id: string): AsyncGenerator<ConfluencePage>;
}

export interface JiraLike {
  updatedSince(cursor: string | null, scope?: string): AsyncGenerator<JiraIssue>;
  getIssue(key: string): Promise<JiraIssue>;
}

export async function ingestConfluenceScope(
  conf: ConfluenceLike,
  scope: Scope,
  tenant: string,
): Promise<void> {
  const { normalize } = await import("../ingest/confluence.js");
  if (scope.kind === "pages") {
    const ids = scope.ids;
    const withDesc = scope.withDescendants;
    console.log(`scope confluence:pages [${ids.join(", ")}]${withDesc ? " +descendants" : ""}`);
    const docs = (async function* () {
      for (const id of ids) {
        yield normalize(await conf.getPage(id), tenant);
        if (withDesc) for await (const p of conf.descendants(id)) yield normalize(p, tenant);
      }
    })();
    await ingestDocs("confluence", docs); // explicit fetch: no cursor
    return;
  }
  const key = cursorKey("confluence", scope);
  if (key === null) throw new Error(`unexpected non-cursor confluence scope: ${scope.kind}`);
  const client = await connect();
  const cursor = await getCursor(client, key);
  await client.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);
  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const p of conf.updatedSince(cursor, pred)) yield normalize(p, tenant);
  })();
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null);
}

export async function ingestJiraScope(jira: JiraLike, scope: Scope, tenant: string): Promise<void> {
  const { normalize } = await import("../ingest/jira.js");
  if (scope.kind === "issues") {
    const keys = scope.keys;
    console.log(`scope jira:issues [${keys.join(", ")}]`);
    const docs = (async function* () {
      for (const k of keys) yield normalize(await jira.getIssue(k), tenant);
    })();
    await ingestDocs("jira", docs); // explicit fetch: no cursor
    return;
  }
  const key = cursorKey("jira", scope);
  if (key === null) throw new Error(`unexpected non-cursor jira scope: ${scope.kind}`);
  const client = await connect();
  const cursor = await getCursor(client, key);
  await client.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);
  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const i of jira.updatedSince(cursor, pred)) yield normalize(i, tenant);
  })();
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null);
}
```
(Consolidate the new `import` lines with any existing ones at the top of the file; do not duplicate the `getCursor`/`connect` imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/pipeline.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck/lint + commit**

Run: `pnpm typecheck && pnpm lint`
```bash
git add ts/ingest/pipeline.ts ts/tests/pipeline.test.ts
git commit -m "ingest: per-scope orchestration (scoped cursor / explicit fetch) + tests"
```

---

### Task 6: Wire scopes + flags into the CLI ingest actions

**Files:**
- Modify: `ts/cli.ts`
- Test: `ts/tests/scope.test.ts` (error-message wiring is already covered by parse\* tests; add a small CLI-parse smoke below)

**Interfaces:**
- Consumes: `parseConfluenceScopes`/`parseJiraScopes` (Task 1); `ingestConfluenceScope`/`ingestJiraScope`, `ingestDocs`, `runReconcile` (Tasks 4-5); `ConfluenceClient`/`JiraClient` (Tasks 2-3).

- [ ] **Step 1: Add flags + orchestration to the confluence action**

In `ts/cli.ts`, extend the `ingest confluence` command. Add options and replace the action body:

```ts
ingest
  .command("confluence")
  .description("Ingest Confluence — fixture, full CQL sync, or a selection (space/page/query)")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--space <keys>", "one or more space keys, comma-separated")
  .option("--page <ids>", "one or more page ids, comma-separated")
  .option("--with-descendants", "with --page: also ingest each page's subtree")
  .option("--query <cql>", "raw CQL predicate (advanced escape hatch)")
  .option("--reconcile", "after a FULL sync, delete catalog docs removed at the source")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { parseConfluenceScopes } = await import("./connectors/scope.js");
    let scopes: import("./connectors/scope.js").Scope[];
    try {
      scopes = parseConfluenceScopes(opts);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { normalize } = await import("./ingest/confluence.js");
    if (opts.fixture) {
      await ingestDocs(
        "confluence",
        fixturePayloads(opts.fixture).map((p) => normalize(p, opts.tenant)),
      );
      return;
    }
    const { ConfluenceClient } = await import("./connectors/confluence.js");
    const { ingestConfluenceScope } = await import("./ingest/pipeline.js");
    const conf = liveClient(
      () => new ConfluenceClient(),
      "EIL_CONFLUENCE_URL and EIL_CONFLUENCE_TOKEN",
    );
    for (const scope of scopes) await ingestConfluenceScope(conf, scope, opts.tenant);
    if (opts.reconcile) await runReconcile("confluence", () => conf.listIds(), opts.tenant);
  });
```

- [ ] **Step 2: Add flags + orchestration to the jira action**

```ts
ingest
  .command("jira")
  .description("Ingest Jira — fixture, full JQL sync, or a selection (project/issue/query)")
  .option("--fixture <path>", "JSON fixture (one item or a list); omit for live sync")
  .option("--project <keys>", "one or more project keys, comma-separated")
  .option("--issue <keys>", "one or more issue keys, comma-separated")
  .option("--query <jql>", "raw JQL predicate (advanced escape hatch)")
  .option("--reconcile", "after a FULL sync, delete catalog docs removed at the source")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (opts) => {
    const { parseJiraScopes } = await import("./connectors/scope.js");
    let scopes: import("./connectors/scope.js").Scope[];
    try {
      scopes = parseJiraScopes(opts);
    } catch (err: any) {
      console.log(err.message);
      process.exit(1);
    }
    const { normalize } = await import("./ingest/jira.js");
    if (opts.fixture) {
      await ingestDocs("jira", fixturePayloads(opts.fixture).map((p) => normalize(p, opts.tenant)));
      return;
    }
    const { JiraClient } = await import("./connectors/jira.js");
    const { ingestJiraScope } = await import("./ingest/pipeline.js");
    const jira = liveClient(() => new JiraClient(), "EIL_JIRA_URL and EIL_JIRA_TOKEN");
    for (const scope of scopes) await ingestJiraScope(jira, scope, opts.tenant);
    if (opts.reconcile) await runReconcile("jira", () => jira.listIds(), opts.tenant);
  });
```

(The obsidian command is unchanged.)

- [ ] **Step 3: Add a CLI-parse smoke test for the rule errors end-to-end**

Append to `ts/tests/scope.test.ts` a check that the same option shapes commander will hand the action produce the documented errors (guards against a flag-name typo drifting from the parser):

```ts
describe("CLI option shapes map to the rules", () => {
  it("confluence: --space + --query is rejected; --with-descendants alone is rejected", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", query: "x" })).toThrow(/at most one/);
    expect(() => parseConfluenceScopes({ withDescendants: true })).toThrow(/--with-descendants/);
  });
  it("jira: --project + --reconcile is rejected", () => {
    expect(() => parseJiraScopes({ project: "PAY", reconcile: true })).toThrow(/full-instance/);
  });
});
```

- [ ] **Step 4: Verify — typecheck, lint, full suite, and live-error smoke**

Run:
```bash
pnpm typecheck && pnpm lint
EIL_DATABASE_URL=pglite://.eil-c pnpm exec vitest run && rm -rf .eil-c
# rule errors exit non-zero with a clean message (no stack trace):
EIL_DATABASE_URL=pglite://.eil-c2 pnpm -s eil ingest confluence --space ENG --reconcile 2>&1 | grep -q "full-instance"; echo "exit rule ok: $?"
rm -rf .eil-c2
# fixture path still works:
EIL_DATABASE_URL=pglite://.eil-c3 pnpm -s eil db migrate >/dev/null && \
  EIL_DATABASE_URL=pglite://.eil-c3 pnpm -s eil ingest confluence --fixture tests/fixtures/confluence_page.json
rm -rf .eil-c3
```
Expected: typecheck/lint clean; suite green; the rule-error grep prints `exit rule ok: 0`; fixture ingest prints `1 seen, 1 changed`.

- [ ] **Step 5: Commit**

```bash
git add ts/cli.ts ts/tests/scope.test.ts
git commit -m "cli: scoped ingest flags (--space/--page/--project/--issue/--query) wired to orchestration"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the selective-ingestion subsection**

In the "## Live connectors (personal credentials only)" section, after the existing `--reconcile` "Deletions" note, add:

```markdown
### Selective ingestion (granularity)

Ingest exactly what you need instead of the whole instance. Pick **one selector
family per run**; each selection re-syncs incrementally under its own cursor.

```sh
# Confluence
pnpm eil ingest confluence --space ENG,OPS         # one or more spaces
pnpm eil ingest confluence --page 12345 --with-descendants   # a page + its subtree
pnpm eil ingest confluence --page 12345,67890      # exact pages
pnpm eil ingest confluence --query 'label = incident'        # raw CQL (page predicate)

# Jira
pnpm eil ingest jira --project PAY,CHK             # one or more projects
pnpm eil ingest jira --issue PAY-981,PAY-42        # exact issues
pnpm eil ingest jira --query 'assignee = currentUser() AND sprint in openSprints()'
```

| Grain | Confluence | Jira |
|---|---|---|
| whole instance | (no flag) | (no flag) |
| container(s) | `--space K[,K2]` | `--project P[,P2]` |
| subtree | `--page ID --with-descendants` | — |
| exact item(s) | `--page ID[,ID2]` | `--issue K[,K2]` |
| anything | `--query '<CQL>'` | `--query '<JQL>'` |

Notes: space/project selections are incremental (own cursor per space/project);
exact `--page`/`--issue` always re-fetch the named items (hash-gated, so
unchanged docs are no-ops). `--reconcile` (deletion sweep) is **full-instance
only** — a scoped listing can't safely decide what to delete outside its scope.
```
```

- [ ] **Step 2: Update the Status checklist**

Change the live-connectors Status line (or add one) to note scoped ingestion:

```markdown
- [x] Live connectors with **selective ingestion** — spaces/pages/subtrees, projects/issues, raw CQL/JQL, per-scope cursors
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: selective ingestion (spaces/pages/projects/issues/query)"
```

---

## Self-Review

**Spec coverage:**
- Granularity ladder (space/page/subtree/page-ids; project/issue) → Tasks 1-3, 5-6. ✓
- Convenience flags + `--query` escape hatch → Task 1 (parse), Task 6 (flags). ✓
- Per-scope cursors, no migration → Task 1 (`cursorKey`), Task 5 (orchestration writes scoped key), tested in pipeline.test.ts. ✓
- One-family / `--with-descendants` / `--fixture` / `--reconcile` rules → Task 1 (parse throws), Task 6 (error handling), tested. ✓
- Regression-preserving connector queries → Tasks 2-3 include explicit legacy-CQL/JQL assertions. ✓
- Scoped reconcile excluded (footgun) → Task 1 rule + Task 6 wiring; documented Task 7. ✓
- Docs + Status → Task 7. ✓

**Placeholder scan:** none — every code step carries complete code; every verify step has commands + expected output.

**Type consistency:** `Scope`, `cursorKey`, `predicate`, `parseConfluenceScopes`/`parseJiraScopes`, `ConfluenceLike`/`JiraLike`, `ingestConfluenceScope`/`ingestJiraScope`, `ingestDocs`/`runReconcile` names and signatures are consistent across tasks and call sites. Connector `updatedSince(cursor, scope?)`/`listIds(scope?)`/`descendants(id)` match what Task 5's interfaces and Task 6's callers expect.
```
