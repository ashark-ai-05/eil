/**
 * Coverage honesty: an answer discloses the basis it rests on.
 *
 * `evidence_verified` closed the case where a snippet was served without being
 * checked. This closes the case one level up: evidence that was never FETCHED.
 * A dead Jira connector produces an answer identical in every field to a healthy
 * one — same citations, same verification, and a `corpus_current_to` computed
 * from the sources that did sync. "Nothing matched" and "that system has not
 * answered since Tuesday" must not arrive wearing the same shape.
 *
 * The disclosure is itself a read path, so it gets the same scrutiny as any
 * other: it must not become a side channel for tenant or ACL state that the
 * results themselves would never have revealed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Coverage, coverageFor } from "../coverage.js";
import type { Db } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { type Viewer, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { setCursor, upsertDocument } from "../store.js";
import { callTool } from "../tools.js";
import { openTestDb } from "./helpers/db.js";

const GROUP = "eng";
const reader = (tenant = "default", groups: string[] = [GROUP]): Viewer =>
  viewerFromAuthenticatedClaims({ principal: "reader", tenant, groups });

const scopeOf = (v: Viewer) => ({
  tenant: v.tenant,
  principal: v.principal,
  groups: v.groups,
});

const coverageOf = (res: Record<string, unknown>): Coverage => res.coverage as Coverage;
const stateOf = (c: Coverage, source: string) => c.sources.find((s) => s.source === source)?.state;

describe("per-source state distinguishes the ways a corpus can be incomplete", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const page = (id: string, body = "Payment retries use exponential backoff.") =>
    upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Retry policy ${id}`,
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2026-03-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels: [],
        body,
      } as never),
    );

  it("a healthy corpus with no match says so, rather than implying a gap", async () => {
    // The control case, and the one that gives every other assertion meaning.
    // If a healthy corpus cannot report `complete: true`, then `complete: false`
    // carries no information and an app is right to ignore it.
    await page("a");
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });

    const res = await searchDocs(db, reader(), "nothing whatsoever matches this", 10);
    expect((res.results as unknown[]) ?? []).toHaveLength(0);

    const cov = coverageOf(res);
    expect(cov.complete).toBe(true);
    expect(stateOf(cov, "confluence")).toBe("current");
    expect(cov.requested_absent).toEqual([]);
  });

  it("a source that has never successfully synced is never_synced, not current", async () => {
    // consecutive_failures can be 0 on a row that has never landed a document,
    // so a naive `failures === 0 ? current : failing` reads a connector that has
    // never once worked as healthy. That is the no-data-reads-as-OK shape.
    await page("a");
    await setCursor(db, "confluence", "c1", "default", { succeeded: false, error: "boom" });

    const cov = await coverageFor(db, scopeOf(reader()), null);
    expect(stateOf(cov, "confluence")).toBe("never_synced");
    expect(cov.complete).toBe(false);
  });

  it("a source that succeeded before and is failing now is failing, not fresh", async () => {
    // The dangerous middle state: `last_success_at` is recent, so every
    // freshness signal looks good, while the connector has not landed anything
    // since. Recency is the misleading part, which is why failing outranks it.
    await page("a");
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });
    await setCursor(db, "confluence", "c1", "default", { succeeded: false, error: "boom" });

    const cov = await coverageFor(db, scopeOf(reader()), null);
    // Precondition: this is genuinely the failed-AFTER-success case, not the
    // never-synced one. Without it the assertion below would also pass for a
    // connector that had never worked, proving nothing about the distinction.
    const row = cov.sources.find((s) => s.source === "confluence");
    expect(row?.last_success_at).not.toBeNull();
    expect(row?.state).toBe("failing");
    expect(row?.consecutive_failures).toBeGreaterThan(0);
    expect(cov.complete).toBe(false);
  });

  it("a stale source clears complete, because the catalog cannot know what it missed", async () => {
    // Whether a corpus past its SLA is merely "behind" or is genuinely missing
    // something depends on whether the SOURCE changed in the meantime, which
    // the catalog has no way to see. `complete` is a positive claim, so unknown
    // must not read as true. The state and timestamp stay, so a caller that
    // considers 40 hours acceptable can still decide that for itself.
    await page("a");
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });
    await db.query(
      "UPDATE sync_cursors SET last_success_at = now() - interval '40 hours' WHERE source = 'confluence'",
    );

    const cov = await coverageFor(db, scopeOf(reader()), null);
    expect(stateOf(cov, "confluence")).toBe("stale");
    expect(cov.complete).toBe(false);
    // Disclosed, not merely denied: the caller still gets the timestamp.
    expect(cov.sources).toHaveLength(1);
    expect(cov.sources[0]?.last_success_at).not.toBeNull();
  });

  it("the SLA boundary is the configured hour, not a hardcoded one", async () => {
    // The remedy for "a slow-cadence deployment reads permanently incomplete"
    // is a configurable SLA, not declaring stale data complete. Both sides of
    // the same corpus are asserted so this cannot pass by the threshold simply
    // never firing.
    await page("a");
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });
    await db.query(
      "UPDATE sync_cursors SET last_success_at = now() - interval '40 hours' WHERE source = 'confluence'",
    );

    expect(stateOf(await coverageFor(db, scopeOf(reader()), null), "confluence")).toBe("stale");

    const prev = process.env.EIL_COVERAGE_SLA_HOURS;
    process.env.EIL_COVERAGE_SLA_HOURS = "72";
    try {
      const relaxed = await coverageFor(db, scopeOf(reader()), null);
      expect(stateOf(relaxed, "confluence")).toBe("current");
      expect(relaxed.complete).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EIL_COVERAGE_SLA_HOURS;
      else process.env.EIL_COVERAGE_SLA_HOURS = prev;
    }
  });

  it("an unparseable SLA falls back to the default rather than switching off", async () => {
    // A typo must not silently disable the disclosure — the failure direction
    // matters more than the value.
    await page("a");
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });
    await db.query(
      "UPDATE sync_cursors SET last_success_at = now() - interval '40 hours' WHERE source = 'confluence'",
    );

    const prev = process.env.EIL_COVERAGE_SLA_HOURS;
    process.env.EIL_COVERAGE_SLA_HOURS = "not-a-number";
    try {
      expect(stateOf(await coverageFor(db, scopeOf(reader()), null), "confluence")).toBe("stale");
    } finally {
      if (prev === undefined) delete process.env.EIL_COVERAGE_SLA_HOURS;
      else process.env.EIL_COVERAGE_SLA_HOURS = prev;
    }
  });

  it("a family reports its sickest scope, not its healthiest", async () => {
    // One freshly-synced space must not vouch for the twelve beside it. Same
    // reasoning as corpusCurrentTo taking min() rather than max().
    await page("a");
    await setCursor(db, "confluence:space:OK", "c1", "default", { succeeded: true });
    await setCursor(db, "confluence:space:DEAD", "c1", "default", { succeeded: false, error: "x" });

    const cov = await coverageFor(db, scopeOf(reader()), null);
    // Precondition: both scopes really did collapse into one family entry, or
    // "sickest wins" is not what is being tested.
    expect(cov.sources.filter((s) => s.source === "confluence")).toHaveLength(1);
    expect(stateOf(cov, "confluence")).toBe("never_synced");
  });
});

describe("a requested source that does not exist is not an empty result", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("names the requested source that has no connector at all", async () => {
    // The caller narrowed scope to Jira precisely because Jira mattered. An
    // empty result set here means "there is no Jira here", and rendering that
    // as "I searched Jira and found nothing" is the one answer a scoped search
    // must never give.
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });

    const cov = await coverageFor(db, scopeOf(reader()), ["jira"]);
    expect(cov.requested_absent).toEqual(["jira"]);
    expect(cov.complete).toBe(false);
  });

  it("does not invent an absence when no source was requested", async () => {
    // `null` means "no filter". Nothing specific was asked for, so nothing
    // specific can be missing — otherwise every unscoped search would report
    // every un-configured connector as a gap.
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });

    const cov = await coverageFor(db, scopeOf(reader()), null);
    expect(cov.requested_absent).toEqual([]);
  });

  it("matches a scoped cursor to the family the caller asked for", async () => {
    // Cursors are scoped (`code:org/repo`); callers name families (`code`).
    // Without the family mapping, a fully-indexed repository reports as an
    // absent source on every scoped search.
    await setCursor(db, "code:org/repo", "sha", "default", { succeeded: true });

    const cov = await coverageFor(db, scopeOf(reader()), ["code"]);
    expect(cov.requested_absent).toEqual([]);
    expect(stateOf(cov, "code")).toBe("current");
  });
});

describe("the disclosure does not leak what the results would not have shown", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const quarantined = async (id: string, aclGroups: string[]) => {
    await upsertDocument(db, {
      ...normalizeConfluence({
        id,
        title: `Secret ${id}`,
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2026-03-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: aclGroups,
        labels: [],
        body: "Payment retries use exponential backoff.",
      } as never),
      aclGroups,
    });
    await db.query(
      "UPDATE documents SET quarantined_at = now() WHERE tenant = 'default' AND id = $1",
      [`confluence:page:${id}`],
    );
  };

  it("counts quarantined evidence the viewer could otherwise have read", async () => {
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });
    await quarantined("mine", [GROUP]);

    const cov = await coverageFor(db, scopeOf(reader()), null);
    expect(cov.quarantined_docs).toBe(1);
    // Something the viewer was entitled to read was withheld, so the answer is
    // not complete — a silent withholding is the failure this whole contract
    // exists to prevent.
    expect(cov.complete).toBe(false);
  });

  it("stays silent about quarantined documents the viewer could never read", async () => {
    // A tenant-wide count would tell every viewer how many documents exist that
    // they have no right to know about. Disclosure narrows the gap between what
    // the answer claims and what the corpus holds; it must not widen what the
    // caller can infer.
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });
    await quarantined("theirs", ["finance"]);

    // Precondition: the document really is quarantined in this tenant, so a
    // zero below is scoping and not an empty table.
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM documents WHERE quarantined_at IS NOT NULL",
    );
    expect(rows[0].n).toBe(1);

    const cov = await coverageFor(db, scopeOf(reader()), null);
    expect(cov.quarantined_docs).toBe(0);
    expect(cov.complete).toBe(true);
  });

  it("reports one tenant's connectors, never a neighbour's", async () => {
    await setCursor(db, "confluence", "c1", "alpha", { succeeded: true });
    await setCursor(db, "jira", "j1", "beta", { succeeded: false, error: "boom" });

    const alpha = await coverageFor(db, scopeOf(reader("alpha")), null);
    expect(alpha.sources.map((s) => s.source)).toEqual(["confluence"]);
    expect(alpha.complete).toBe(true);

    // And the reverse direction: beta must not be blessed by alpha's health.
    const beta = await coverageFor(db, scopeOf(reader("beta")), null);
    expect(beta.sources.map((s) => s.source)).toEqual(["jira"]);
    expect(beta.complete).toBe(false);
  });

  it("never carries the connector's error text", async () => {
    // `last_error` is free text from the source system and routinely holds
    // hostnames, internal URLs and occasionally a credential in a query string.
    // The viewer needs to know a source is failing; the reason is an operator
    // question. Asserted on the serialised envelope so a field added later
    // cannot reintroduce it unnoticed.
    await setCursor(db, "confluence", "c1", "default", {
      succeeded: false,
      error: "401 from https://wiki.corp.internal/rest/api?os_authType=basic&token=SUPERSECRET",
    });

    const cov = await coverageFor(db, scopeOf(reader()), null);
    const serialised = JSON.stringify(cov);
    expect(serialised).not.toContain("SUPERSECRET");
    expect(serialised).not.toContain("wiki.corp.internal");
    expect(serialised).not.toContain("last_error");
  });
});

describe("coverage describes the sources this answer actually consulted", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const healthyCodeFailingJira = async () => {
    await setCursor(db, "code:org/repo", "sha", "default", { succeeded: true });
    await setCursor(db, "jira", "j1", "default", { succeeded: true });
    await setCursor(db, "jira", "j1", "default", { succeeded: false, error: "boom" });
  };

  it("a dead Jira connector does not make a code-only answer incomplete", async () => {
    // The whole point of scoping. An unrelated failing source clearing
    // `complete` on an answer that never touched it teaches callers to ignore
    // the flag — and they will then ignore it on the answers where it matters.
    await healthyCodeFailingJira();

    const cov = await coverageFor(db, scopeOf(reader()), ["code"]);
    expect(cov.sources.map((s) => s.source)).toEqual(["code"]);
    expect(cov.complete).toBe(true);
  });

  it("and the reverse: a healthy code index does not rescue a Jira answer", async () => {
    // Asserted in both directions so the scoping cannot pass by accidentally
    // filtering everything, or nothing.
    await healthyCodeFailingJira();

    const cov = await coverageFor(db, scopeOf(reader()), ["jira"]);
    expect(cov.sources.map((s) => s.source)).toEqual(["jira"]);
    expect(cov.complete).toBe(false);
  });

  it("an unfiltered answer still reports every connector", async () => {
    // Scoping must not become a way to hide a broken source: with no filter the
    // basis is genuinely everything.
    await healthyCodeFailingJira();

    const cov = await coverageFor(db, scopeOf(reader()), null);
    expect(cov.sources.map((s) => s.source)).toEqual(["code", "jira"]);
    expect(cov.complete).toBe(false);
  });
});

describe("documents lost inside a successful run are disclosed", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("a partial run is incomplete despite a fresh last_success_at", async () => {
    // The gap consecutive_failures cannot express: a run that listed 4,000
    // files, could not read 3, and finished. Before this the code path called
    // setCursor with the default {succeeded: true}, so that run recorded a
    // fresh success and a zero failure count while three documents were simply
    // absent — and absence is indistinguishable from "nothing to find".
    await setCursor(db, "code:org/repo", "sha", "default", {
      succeeded: true,
      itemFailures: 3,
    });

    const cov = await coverageFor(db, scopeOf(reader()), ["code"]);
    const row = cov.sources.find((s) => s.source === "code");
    // Preconditions: this really is the fresh-success case, so the incomplete
    // verdict below can only be coming from the item count.
    expect(row?.state).toBe("current");
    expect(row?.last_success_at).not.toBeNull();
    expect(row?.consecutive_failures).toBe(0);

    expect(row?.item_failures).toBe(3);
    expect(cov.complete).toBe(false);
  });

  it("the count is per-run, so a clean re-run clears it", async () => {
    // A cumulative total could only grow and would stop describing the corpus
    // as it stands, which is the question coverage is answering.
    await setCursor(db, "code:org/repo", "sha", "default", { succeeded: true, itemFailures: 3 });
    await setCursor(db, "code:org/repo", "sha2", "default", { succeeded: true, itemFailures: 0 });

    const cov = await coverageFor(db, scopeOf(reader()), ["code"]);
    expect(cov.sources.find((s) => s.source === "code")?.item_failures).toBe(0);
    expect(cov.complete).toBe(true);
  });

  it("a family sums the documents lost across its scopes", async () => {
    await setCursor(db, "code:org/a", "sha", "default", { succeeded: true, itemFailures: 2 });
    await setCursor(db, "code:org/b", "sha", "default", { succeeded: true, itemFailures: 1 });

    const cov = await coverageFor(db, scopeOf(reader()), ["code"]);
    expect(cov.sources.find((s) => s.source === "code")?.item_failures).toBe(3);
  });

  it("the ingest path records unreadable files, and policy skips are not failures", async () => {
    // Exercised through ingestRepo rather than setCursor, because the defect
    // was in the CALLER: it passed no outcome at all and took the
    // {succeeded: true} default. Testing the store alone would have missed it.
    //
    // The fixture mixes both kinds deliberately: a file the filter excludes and
    // a file that cannot be read. Folding those into one number would report
    // every real repository — all of which skip vendored trees and binaries —
    // as permanently incomplete.
    const { ingestRepo } = await import("../ingest/pipeline.js");
    const { RepoFilter } = await import("../ingest/repofilter.js");

    const files = ["src/ok.ts", "src/unreadable.ts", "vendor/skip.md"];
    const source = {
      headSha: async () => "sha-1",
      listFiles: async function* () {
        for (const f of files) yield f;
      },
      changedSince: async function* () {},
      readFile: async (p: string) => {
        if (p === "src/unreadable.ts") throw new Error("EIO: simulated read failure");
        return "export function ok() {}";
      },
      blobUrl: () => null,
      lastModified: async () => null,
      dispose: async () => {},
    };

    const out = await ingestRepo(
      source as never,
      "org/repo",
      undefined,
      new RepoFilter({ includes: ["**/*.ts"] }),
      "default",
      [GROUP],
    );

    // Precondition: the run genuinely landed something AND lost something, or
    // the distinction under test never arose.
    expect(out.upserted).toBeGreaterThan(0);
    expect(out.failed).toBe(1);
    expect(out.skipped).toBeGreaterThanOrEqual(1);

    // A fresh connection: ingestRepo opens and closes its own, and a second
    // PGlite handle on the same directory does not observe the first's writes
    // until it is reopened. Reusing `db` here reported zero sources and would
    // have made the assertions below vacuous.
    const { connect } = await import("../db.js");
    const fresh = await connect();
    try {
      const cov = await coverageFor(fresh, scopeOf(reader()), ["code"]);
      const row = cov.sources.find((s) => s.source === "code");
      // Precondition: the cursor row is actually visible on this handle.
      expect(row).toBeDefined();
      expect(row?.item_failures).toBe(1);
      expect(cov.complete).toBe(false);
    } finally {
      await fresh.end();
    }
  });
});

describe("a failed item is guaranteed to be in the next run's scan", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  /**
   * The per-run item-failure count is only truthful if the failed items are
   * certain to be rescanned. Advancing the cursor to `head` after a partial run
   * puts an unreadable, UNCHANGED file permanently behind it — no later
   * incremental scan lists it again, so the next run triggered by an unrelated
   * commit reads everything it sees, records zero failures, and restores
   * `complete: true` while that document stays missing forever.
   *
   * Four runs, because the two-run version cannot tell "the cursor was held"
   * apart from "the file happened to be rescanned": run 0 establishes a real
   * prior cursor so runs 1-2 exercise the INCREMENTAL path, which is the one
   * that strands the file.
   */
  const mkSource = (head: string, files: Record<string, string | Error>, changed: string[]) =>
    ({
      headSha: async () => head,
      async *listFiles() {
        for (const p of Object.keys(files)) yield p;
      },
      // Keyed off the base sha the caller passes, which is the whole point:
      // holding the cursor changes WHICH changes the next run is handed.
      async *changedSince(sha: string) {
        for (const p of changed) yield { path: p, status: "M" as const, since: sha };
      },
      readFile: async (p: string) => {
        const v = files[p];
        if (v instanceof Error) throw v;
        return v ?? "";
      },
      blobUrl: () => null,
      lastModified: async () => null,
      dispose: async () => {},
    }) as never;

  it("holds the cursor past a failure, and only clears the debt once the file lands", async () => {
    const { ingestRepo } = await import("../ingest/pipeline.js");
    const { RepoFilter } = await import("../ingest/repofilter.js");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const filter = new RepoFilter({ includes: ["**/*.ts"] });
    const run = (s: unknown) =>
      ingestRepo(s as never, "org/repo", undefined, filter, "default", [GROUP]);

    const ok = "export function ok() {}";
    const unreadable = new Error("EIO: simulated read failure");

    // Run 0 — everything readable. Establishes a real prior cursor so the runs
    // below take the incremental path rather than the full-listing fallback.
    await run(mkSource("sha0", { "src/a.ts": ok, "src/bad.ts": ok }, []));
    let c = await connect();
    expect(await getCursor(c, "code:org/repo")).toBe("sha0");
    await c.end();

    // Run 1 — bad.ts changed and cannot be read.
    const r1 = await run(
      mkSource("sha1", { "src/a.ts": ok, "src/bad.ts": unreadable }, ["src/bad.ts"]),
    );
    expect(r1.failed).toBe(1);
    c = await connect();
    // The cursor must NOT have advanced. If it did, bad.ts is now behind it.
    expect(await getCursor(c, "code:org/repo")).toBe("sha0");
    await c.end();

    // Run 2 — an unrelated file changes; bad.ts is still unreadable and did NOT
    // change. This is the run that used to launder the failure away: with the
    // cursor at sha1, changedSince(sha1) yields only the unrelated file, every
    // read succeeds, itemFailures is written as 0 and coverage returns complete
    // while bad.ts is permanently absent.
    const r2 = await run(
      mkSource("sha2", { "src/a.ts": ok, "src/bad.ts": unreadable, "src/other.ts": ok }, [
        "src/bad.ts",
        "src/other.ts",
      ]),
    );
    // Precondition: the held cursor really did hand this run the failed file
    // again, rather than the run passing because nothing was retried.
    expect(r2.failed).toBe(1);
    c = await connect();
    expect(await getCursor(c, "code:org/repo")).toBe("sha0");
    let cov = await coverageFor(c, scopeOf(reader()), ["code"]);
    expect(cov.sources.find((s) => s.source === "code")?.item_failures).toBe(1);
    expect(cov.complete).toBe(false);
    await c.end();

    // Run 3 — the file becomes readable. Now, and only now, may the cursor
    // advance and the debt clear.
    const r3 = await run(
      mkSource("sha3", { "src/a.ts": ok, "src/bad.ts": ok, "src/other.ts": ok }, [
        "src/bad.ts",
        "src/other.ts",
      ]),
    );
    expect(r3.failed).toBe(0);
    c = await connect();
    try {
      expect(await getCursor(c, "code:org/repo")).toBe("sha3");
      cov = await coverageFor(c, scopeOf(reader()), ["code"]);
      expect(cov.sources.find((s) => s.source === "code")?.item_failures).toBe(0);
      expect(cov.complete).toBe(true);
      // The formerly unreadable file actually landed — the point of the retry.
      const doc = await c.query("SELECT 1 FROM documents WHERE id = $1 AND tenant = 'default'", [
        "code:org/repo:src/bad.ts",
      ]);
      expect(doc.rows.length).toBe(1);
    } finally {
      await c.end();
    }
  });

  it("a first full run that loses a file does not establish a successful head", async () => {
    // With no prior cursor there is no earlier position to fall back to, so the
    // hold is at null. That is not a lost cursor: it is what forces the next run
    // to re-list the whole repository, which necessarily includes the failure.
    const { ingestRepo } = await import("../ingest/pipeline.js");
    const { RepoFilter } = await import("../ingest/repofilter.js");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");

    const out = await ingestRepo(
      mkSource(
        "sha1",
        { "src/a.ts": "export function ok() {}", "src/bad.ts": new Error("EIO") },
        [],
      ),
      "org/repo",
      undefined,
      new RepoFilter({ includes: ["**/*.ts"] }),
      "default",
      [GROUP],
    );
    expect(out.failed).toBe(1);

    const c = await connect();
    try {
      // Not sha1: a successful head here would strand bad.ts behind it.
      expect(await getCursor(c, "code:org/repo")).toBeNull();
      const cov = await coverageFor(c, scopeOf(reader()), ["code"]);
      expect(cov.complete).toBe(false);
      // never_synced, not current: nothing has cleanly landed for this source.
      expect(cov.sources.find((s) => s.source === "code")?.state).toBe("never_synced");
    } finally {
      await c.end();
    }
  });
});

describe("the envelope is identical on every route", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const jiraIssue = async (key: string) => {
    const { normalize } = await import("../ingest/jira.js");
    await upsertDocument(db, {
      ...normalize({
        key,
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
  };

  const codeFile = async (path: string) => {
    const { normalizeCode } = await import("../ingest/code.js");
    const { replaceCodeIndex } = await import("../store.js");
    const doc = normalizeCode(
      "org/r",
      path,
      "export function retryCharge() {}",
      null,
      "default",
      "sha",
      "2026-03-01T00:00:00Z",
    );
    await upsertDocument(db, { ...doc, aclGroups: [GROUP] });
    await replaceCodeIndex(db, { ...doc, aclGroups: [GROUP] }, "org/r", path, "sha");
  };

  it("the entity shortcut carries coverage", async () => {
    await jiraIssue("PAY-981");
    const res = await searchDocs(db, reader(), "PAY-981", 10);
    expect(res.route).toBe("entity");
    expect(res).toHaveProperty("coverage");
    expect(coverageOf(res)).toHaveProperty("complete");
  });

  it("the code shortcut carries coverage", async () => {
    await codeFile("src/pay/retry.ts");
    const res = await searchDocs(db, reader(), "src/pay/retry.ts", 10);
    expect(res.route).toBe("path");
    expect(res).toHaveProperty("coverage");
    expect(coverageOf(res)).toHaveProperty("complete");
  });

  it("the direct search_code tool carries coverage, scoped to code", async () => {
    await codeFile("src/pay/retry.ts");
    const out = await callTool(
      "search_code",
      { query: "src/pay/retry.ts", kind: "path", limit: 5 },
      reader(),
      db,
    );
    expect((out.results as unknown[]).length).toBeGreaterThan(0);
    const cov = out.coverage as Coverage;
    // This tool reads exactly one source, so an absent code connector is a fact
    // about THIS answer. Passing null would have let a missing index read as an
    // empty repository.
    expect(cov.requested_absent).toEqual(["code"]);
  });

  it("the lexical route carries coverage", async () => {
    await upsertDocument(
      db,
      normalizeConfluence({
        id: "p",
        title: "Retry policy",
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2026-03-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels: [],
        body: "Payment retries use exponential backoff.",
      } as never),
    );
    await setCursor(db, "confluence", "c1", "default", { succeeded: true });

    const res = await searchDocs(db, reader(), "payment retries exponential backoff", 10);
    expect((res.results as unknown[]).length).toBeGreaterThan(0);
    expect(coverageOf(res).complete).toBe(true);
  });
});
