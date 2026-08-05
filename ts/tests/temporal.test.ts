/**
 * Temporal validity: "when was this last edited" and "is this still true" are
 * different facts, and EIL only had the first.
 *
 * The failure this closes is invisible to recall@k. A superseded runbook is
 * genuinely topically relevant — right subject, wrong answer — so every metric
 * that scores relevance says retrieval did well while the agent acts on a
 * replaced policy. Only excluding it can fix that; ranking it lower cannot,
 * because a strong lexical match still wins.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash } from "../contracts/models.js";
import type { Db } from "../db.js";
import { RETIRED_DATE_UNKNOWN, normalize as normalizeConfluence } from "../ingest/confluence.js";
import { type Viewer, getDoc, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

const GROUP = "eng";
const reader = (): Viewer =>
  viewerFromAuthenticatedClaims({ principal: "reader", tenant: "default", groups: [GROUP] });

describe("supersession is derived from the source, deterministically", () => {
  const page = (labels: string[]) =>
    normalizeConfluence({
      id: "1",
      title: "Payment retry policy",
      url: null,
      author: null,
      updated: "2026-03-01T00:00:00Z",
      created: "2024-01-01T00:00:00Z",
      ancestors: ["ENG"],
      acl_groups: [GROUP],
      labels,
      body: "Retries stop after 3 attempts.",
    } as never);

  it("marks a page carrying a retirement label as no longer valid", () => {
    for (const label of ["deprecated", "archived", "obsolete", "superseded"]) {
      expect(page([label]).validTo, label).toBeTruthy();
    }
  });

  it("leaves an ordinary page current", () => {
    expect(page(["runbook", "payments"]).validTo).toBeFalsy();
  });

  it("is case- and whitespace-insensitive, because labels are user-typed", () => {
    expect(page(["  Deprecated  "]).validTo).toBeTruthy();
  });

  it("dates the end of validity at the last edit, not at ingest time", () => {
    // Ingest time would make the same page produce a different hash on every
    // run, defeating the content-hash gate and re-embedding the corpus nightly.
    expect(page(["deprecated"]).validTo).toBe("2026-03-01T00:00:00Z");
  });

  it("is covered by contentHash, so retirement alone triggers a rewrite", () => {
    // A page can gain an "obsolete" label with no body edit. If the hash ignored
    // validity the write would be skipped and the document would keep being
    // served as current — the same failure shape the aclGroups fix closed.
    //
    // Compared with an IDENTICAL body on purpose: normalize() prepends labels to
    // the body, so comparing two normalize() outputs would differ for that
    // reason alone and pass whether or not validity were hashed at all.
    const base = {
      title: "t",
      url: null,
      hierarchy: ["ENG"],
      aclGroups: [GROUP],
      qualityTier: "authored" as const,
      updatedAt: "2026-03-01T00:00:00Z",
      supersededBy: null,
      body: "identical body",
    };
    expect(contentHash({ ...base, validTo: null })).not.toBe(
      contentHash({ ...base, validTo: "2026-03-01T00:00:00Z" }),
    );
  });
});

describe("superseded documents are excluded from retrieval", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const ingest = async (id: string, body: string, labels: string[]) =>
    upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Payment retry policy ${id}`,
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2024-01-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels,
        body,
      } as never),
    );

  it("returns the replacement and not the retired page", async () => {
    await ingest("old", "Payment retries stop after 3 attempts.", ["deprecated"]);
    await ingest("new", "Payment retries stop after 5 attempts.", ["runbook"]);

    const res = await searchDocs(db, reader(), "payment retries attempts", 10);
    const ids = ((res?.results ?? []) as Array<{ id: string }>).map((r) => r.id);

    expect(ids).toContain("confluence:page:new");
    expect(ids).not.toContain("confluence:page:old");
  });

  it("a retired page is gone even when it is the only match", async () => {
    // Fail closed: better an honest empty result than a confident wrong one.
    await ingest("old", "Counterparty limit amendment procedure.", ["obsolete"]);
    const res = await searchDocs(db, reader(), "counterparty limit amendment", 10);
    expect((res?.results ?? []) as unknown[]).toHaveLength(0);
  });
});

describe("retirement fails closed when the source gives no date", () => {
  const page = (labels: string[], stamps: { updated?: string; created?: string }) =>
    normalizeConfluence({
      id: "1",
      title: "t",
      url: null,
      author: null,
      updated: stamps.updated ?? null,
      created: stamps.created ?? null,
      ancestors: ["ENG"],
      acl_groups: [GROUP],
      labels,
      body: "b",
    } as never);

  it("falls back to created when updated is absent", () => {
    expect(page(["deprecated"], { created: "2024-01-01T00:00:00Z" }).validTo).toBe(
      "2024-01-01T00:00:00Z",
    );
  });

  it("uses a fixed sentinel when the source reports no timestamp at all", () => {
    // Returning null here would silently restore a KNOWN-retired page to the
    // live corpus because the source happened not to report a date. Retirement
    // is the certain fact; the date is the uncertain one.
    expect(page(["deprecated"], {}).validTo).toBe(RETIRED_DATE_UNKNOWN);
  });

  it("keeps the sentinel stable across runs, so the hash gate still works", () => {
    expect(page(["deprecated"], {}).validTo).toBe(page(["deprecated"], {}).validTo);
  });
});

describe("history is excluded by default but not unreachable", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const ingest = async (id: string, labels: string[]) =>
    upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Retry policy ${id}`,
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2024-01-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: [GROUP],
        labels,
        body: "Counterparty limit amendment procedure.",
      } as never),
    );

  it("search returns a retired page only when explicitly asked", async () => {
    await ingest("old", ["deprecated"]);
    const hidden = await searchDocs(db, reader(), "counterparty limit amendment", 10);
    expect((hidden?.results ?? []) as unknown[]).toHaveLength(0);

    const shown = await searchDocs(db, reader(), "counterparty limit amendment", 10, undefined, {
      includeSuperseded: true,
    });
    const ids = ((shown?.results ?? []) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("confluence:page:old");
  });

  it("get_doc by exact id is retrievable with the opt-in, not a permanent 404", async () => {
    await ingest("old", ["archived"]);
    expect(await getDoc(db, reader(), "confluence:page:old")).toBeNull();
    const doc = await getDoc(db, reader(), "confluence:page:old", 0, undefined, true);
    expect(doc?.id).toBe("confluence:page:old");
  });

  it("the opt-in relaxes validity ONLY — ACL still refuses another tenant's viewer", async () => {
    await ingest("old", ["archived"]);
    const outsider = viewerFromAuthenticatedClaims({
      principal: "outsider",
      tenant: "default",
      groups: ["other-team"],
    });
    expect(await getDoc(db, outsider, "confluence:page:old", 0, undefined, true)).toBeNull();
    const res = await searchDocs(db, outsider, "counterparty limit amendment", 10, undefined, {
      includeSuperseded: true,
    });
    expect((res?.results ?? []) as unknown[]).toHaveLength(0);
  });
});
