/**
 * Freshness bounds on the answer, not just on each result.
 *
 * An agent handed ten citations has no cheap way to ask "how old is the oldest
 * thing this rests on". Two bounds plus corpus currency answer it without a
 * second call:
 *
 *   evidence_as_of_oldest  the WEAKEST freshness claim the answer can make
 *   evidence_as_of_newest  the strongest
 *   corpus_current_to      when the catalog itself last synced successfully
 *
 * Deliberately two numbers rather than one aggregate. A single `as_of` is
 * ambiguous — freshest source or stalest? — and the two readings differ by
 * years on a real corpus. If one is ever forced, it must be the oldest: a
 * conclusion is only as current as the stalest evidence under it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db.js";
import { normalizeCode } from "../ingest/code.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { normalize as normalizeJira } from "../ingest/jira.js";
import { type Viewer, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { replaceCodeIndex, setCursor, upsertDocument } from "../store.js";
import { callTool } from "../tools.js";
import { openTestDb } from "./helpers/db.js";

const GROUP = "eng";
const reader = (): Viewer =>
  viewerFromAuthenticatedClaims({ principal: "reader", tenant: "default", groups: [GROUP] });

describe("answer-level freshness bounds", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const ingest = (id: string, updated: string) =>
    upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Retry policy ${id}`,
        url: null,
        author: null,
        updated,
        created: updated,
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels: [],
        body: "Payment retries use exponential backoff.",
      } as never),
    );

  it("reports the oldest and newest evidence actually cited", async () => {
    await ingest("old", "2021-01-01T00:00:00Z");
    await ingest("mid", "2023-06-01T00:00:00Z");
    await ingest("new", "2026-03-01T00:00:00Z");

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    expect((res.results as unknown[]).length).toBeGreaterThan(1);
    expect(String(res.evidence_as_of_oldest)).toContain("2021");
    expect(String(res.evidence_as_of_newest)).toContain("2026");
  });

  it("bounds the ANSWER, not the corpus — a narrow result set reports its own span", async () => {
    // The 2021 page exists but does not match, so it must not drag the bound
    // down. These describe the evidence returned, nothing else.
    //
    // The two documents need genuinely disjoint text: an earlier version of this
    // test gave them identical bodies, so BOTH matched, the guard it was written
    // with never fired, and it asserted nothing at all while reporting green.
    await ingest("old", "2021-01-01T00:00:00Z");
    await upsertDocument(
      db,
      normalizeConfluence({
        id: "new",
        title: "Counterparty limit amendment",
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2026-03-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels: [],
        body: "Amendments to counterparty exposure bands are published quarterly.",
      } as never),
    );

    const res = await searchDocs(db, reader(), "counterparty exposure bands quarterly", 10);
    const ids = (res.results as Array<{ id: string }>).map((r) => r.id);
    // Assert the PRECONDITION, do not guard on it. An `if` here would make the
    // test vacuous the day the router stops isolating this query — it would
    // report green while asserting nothing, which is the failure mode this
    // whole feature exists to prevent.
    expect(ids).toEqual(["confluence:page:new"]);
    expect(String(res.evidence_as_of_oldest)).toContain("2026");
    expect(String(res.evidence_as_of_newest)).toContain("2026");
  });

  it("reports corpus currency from the last SUCCESSFUL sync", async () => {
    await ingest("new", "2026-03-01T00:00:00Z");
    await setCursor(db, "confluence", "2026-03-01T00:00:00Z", "default", { succeeded: true });

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    expect(res.corpus_current_to).toBeTruthy();
  });

  it("says corpus currency is unknown rather than guessing when nothing has synced", async () => {
    // A failed-only connector must not look fresh. Absence is reported as null,
    // not silently omitted, so a caller cannot mistake "never synced" for "just
    // synced" — the same reason a no-data alert must not read as OK.
    await ingest("new", "2026-03-01T00:00:00Z");
    await setCursor(db, "confluence", "2026-03-01T00:00:00Z", "default", {
      succeeded: false,
      error: "boom",
    });

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    expect(res).toHaveProperty("corpus_current_to");
    expect(res.corpus_current_to).toBeNull();
  });

  it("reports null bounds for an empty result set rather than omitting them", async () => {
    const res = await searchDocs(db, reader(), "nothing matches this query at all", 10);
    expect(res).toHaveProperty("evidence_as_of_oldest");
    expect(res.evidence_as_of_oldest).toBeNull();
    expect(res.evidence_as_of_newest).toBeNull();
  });
});

describe("fail-open gaps found in review", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const doc = (id: string, updated: string | null, labels: string[] = []) =>
    upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Retry policy ${id}`,
        url: null,
        author: null,
        updated,
        created: updated,
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels,
        body: "Payment retries use exponential backoff.",
      } as never),
    );

  it("corpus currency is the OLDEST successful sync, not the newest", async () => {
    // One freshly-synced scope must not vouch for a scope that last succeeded
    // months ago. A corpus is only as current as its least current source.
    await doc("a", "2026-03-01T00:00:00Z");
    await setCursor(db, "confluence:space:OLD", "2021-01-01T00:00:00Z", "default", {
      succeeded: true,
    });
    await db.query(
      "UPDATE sync_cursors SET last_success_at = '2021-01-01T00:00:00Z' WHERE source = $1",
      ["confluence:space:OLD"],
    );
    await setCursor(db, "confluence:space:NEW", "2026-03-01T00:00:00Z", "default", {
      succeeded: true,
    });

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    expect(String(res.corpus_current_to)).toContain("2021");
  });

  it("corpus currency is null when ANY scope has never succeeded", async () => {
    // A source that never landed a document has no currency to contribute, and
    // omitting it would let the healthy sources vouch for data never fetched.
    await doc("a", "2026-03-01T00:00:00Z");
    await setCursor(db, "confluence:space:OK", "2026-03-01T00:00:00Z", "default", {
      succeeded: true,
    });
    await setCursor(db, "confluence:space:BROKEN", "2026-03-01T00:00:00Z", "default", {
      succeeded: false,
      error: "boom",
    });

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    expect(res.corpus_current_to).toBeNull();
  });

  it("one undated citation makes the oldest bound unknown, not optimistic", async () => {
    await doc("dated", "2026-03-01T00:00:00Z");
    await doc("undated", null);

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    const ids = (res.results as Array<{ id: string }>).map((r) => r.id);
    // Precondition asserted, not guarded: both documents must actually be cited
    // or this proves nothing about mixed known/unknown timestamps.
    expect(ids).toContain("confluence:page:dated");
    expect(ids).toContain("confluence:page:undated");
    expect(res.evidence_as_of_oldest).toBeNull();
    // The newest known stamp still means something: SOMETHING here is at least
    // this recent, whatever else is undated.
    expect(String(res.evidence_as_of_newest)).toContain("2026");
  });
});

describe("the freshness contract covers the shortcut routes too", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const codeDoc = async (path: string, updated: string | null, labels: string[] = []) => {
    const doc = normalizeCode(
      "org/r",
      path,
      "export function retryCharge() {}",
      null,
      "default",
      "sha",
      updated,
    );
    await upsertDocument(db, {
      ...doc,
      aclGroups: [GROUP],
      ...(labels.includes("deprecated") ? { validTo: "2026-03-01T00:00:00Z" } : {}),
    });
    await replaceCodeIndex(db, { ...doc, aclGroups: [GROUP] }, "org/r", path, "sha");
  };

  it("a dated code answer reports matching bounds and corpus currency", async () => {
    await codeDoc("src/pay/retry.ts", "2026-03-01T00:00:00Z");
    await setCursor(db, "code:org/r", "sha", "default", { succeeded: true });

    const res = await searchDocs(db, reader(), "src/pay/retry.ts", 10);
    expect(res.route).toBe("path");
    expect(String(res.evidence_as_of_oldest)).toContain("2026");
    expect(String(res.evidence_as_of_newest)).toContain("2026");
    expect(res).toHaveProperty("corpus_current_to");
  });

  it("retired code is excluded by default and returned only on explicit opt-in", async () => {
    // The code index is a separate read path that never composed visibleSql, so
    // a retired file stayed citable here long after prose search dropped it.
    await codeDoc("src/pay/legacy.ts", "2026-03-01T00:00:00Z", ["deprecated"]);

    const hidden = await searchDocs(db, reader(), "src/pay/legacy.ts", 10);
    expect((hidden.results ?? []) as unknown[]).toHaveLength(0);

    const shown = await searchDocs(db, reader(), "src/pay/legacy.ts", 10, undefined, {
      includeSuperseded: true,
    });
    expect((shown.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("the entity shortcut carries all three freshness fields", async () => {
    await upsertDocument(db, {
      ...normalizeJira({
        key: "PAY-981",
        url: null,
        fields: {
          summary: "Retry storm",
          project: "PAY",
          description: "d",
          updated: "2026-03-01T00:00:00Z",
          created: "2026-03-01T00:00:00Z",
        },
      } as never),
      aclGroups: [GROUP],
    });

    const res = await searchDocs(db, reader(), "PAY-981", 10);
    expect(res.route).toBe("entity");
    expect(res).toHaveProperty("evidence_as_of_oldest");
    expect(res).toHaveProperty("evidence_as_of_newest");
    expect(res).toHaveProperty("corpus_current_to");
  });

  it("the direct search_code tool answer carries freshness too", async () => {
    await codeDoc("src/pay/retry.ts", "2026-03-01T00:00:00Z");
    const out = await callTool(
      "search_code",
      { query: "src/pay/retry.ts", kind: "path", limit: 5 },
      reader(),
      db,
    );
    expect((out.results as unknown[]).length).toBeGreaterThan(0);
    expect(out).toHaveProperty("evidence_as_of_oldest");
    expect(out).toHaveProperty("evidence_as_of_newest");
    expect(out).toHaveProperty("corpus_current_to");
    expect(String(out.evidence_as_of_newest)).toContain("2026");
  });
});
