/**
 * The evidence contract: a snippet is checked against the document it claims to
 * come from, at answer time, before it is served.
 *
 * `eil reqs check` already does this for requirements artefacts — it re-reads
 * every cited quote out of the catalog and refuses by name when the quote is
 * no longer there. That is the single most differentiated thing EIL does, and
 * it guarded exactly one command. Retrieval trusted the index.
 *
 * Trusting the index is reasonable right up until the index and the source
 * disagree, and when they disagree the answer is a quotation the document does
 * not contain — indistinguishable, to the agent reading it, from a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { type Viewer, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

const GROUP = "eng";
const reader = (): Viewer =>
  viewerFromAuthenticatedClaims({ principal: "reader", tenant: "default", groups: [GROUP] });

describe("cited evidence is re-checked against the document at answer time", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const ingest = (id: string, body: string) =>
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

  /**
   * Rewrite the body WITHOUT re-chunking, which is what divergence looks like:
   * a fresh-fetch that updated the document, a partial write, a restore, a
   * hand-edit. The chunk still says the old thing; the document no longer does.
   */
  const rewriteBodyOnly = (id: string, body: string) =>
    db.query("UPDATE documents SET body = $1 WHERE tenant = 'default' AND id = $2", [
      body,
      `confluence:page:${id}`,
    ]);

  it("serves a snippet the document still contains", async () => {
    await ingest("ok", "Payment retries stop after three attempts.");
    const res = await searchDocs(db, reader(), "payment retries attempts", 10);
    const ids = (res.results as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("confluence:page:ok");
    expect(res.unverified_excluded).toBe(0);
  });

  it("withholds a snippet the document no longer contains", async () => {
    await ingest("drift", "Payment retries stop after three attempts.");
    // The catalog now says something else; the chunk index was not rebuilt.
    await rewriteBodyOnly("drift", "This page has been rewritten and says nothing about retries.");

    const res = await searchDocs(db, reader(), "payment retries attempts", 10);
    const ids = (res.results as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain("confluence:page:drift");
  });

  it("counts what it withheld, so the exclusion is never silent", async () => {
    // An empty result set with no explanation is the failure this whole feature
    // exists to prevent: the agent cannot tell "nothing matched" from "I refused
    // to quote something I could not verify".
    await ingest("drift", "Payment retries stop after three attempts.");
    await rewriteBodyOnly("drift", "Rewritten, unrelated.");

    const res = await searchDocs(db, reader(), "payment retries attempts", 10);
    expect(res.unverified_excluded).toBe(1);
  });

  it("returns unverifiable evidence only when explicitly asked, and marks it", async () => {
    await ingest("drift", "Payment retries stop after three attempts.");
    await rewriteBodyOnly("drift", "Rewritten, unrelated.");

    const res = await searchDocs(db, reader(), "payment retries attempts", 10, undefined, {
      includeUnverified: true,
    });
    const hit = (res.results as Array<{ id: string; evidence_verified?: boolean }>).find(
      (r) => r.id === "confluence:page:drift",
    );
    expect(hit).toBeDefined();
    expect(hit?.evidence_verified).toBe(false);
  });

  it("marks verified evidence as verified rather than leaving it unstated", async () => {
    await ingest("ok", "Payment retries stop after three attempts.");
    const res = await searchDocs(db, reader(), "payment retries attempts", 10);
    const hit = (res.results as Array<{ id: string; evidence_verified?: boolean }>)[0];
    expect(hit?.evidence_verified).toBe(true);
  });
});

describe("the contract holds on every arm, not just the one it was written for", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const ingest = (id: string, body: string) =>
    upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Doc ${id}`,
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

  it("an unset verification flag counts as UNVERIFIED, never as verified", async () => {
    // The original filter said `!== false`, so any arm that failed to project
    // the column had its results served under a contract asserting they had
    // been checked. The defensive-looking comparison was itself the fail-open.
    // This pins the direction: only an explicit true passes.
    const { evidenceIsVerified } = await import("../search.js");
    expect(evidenceIsVerified(undefined)).toBe(false);
    expect(evidenceIsVerified(false)).toBe(false);
    expect(evidenceIsVerified(true)).toBe(true);
  });

  it("direct search_code reports an explicit zero rather than omitting the count", async () => {
    // Zero by construction: a code citation is a line window cut from the
    // current body, so nothing can be withheld. Stated so a caller cannot tell
    // "nothing withheld" apart from "this path forgot to say".
    const { callTool } = await import("../tools.js");
    const out = await callTool(
      "search_code",
      { query: "nothing/matches/this/path.ts", kind: "path", limit: 5 },
      reader(),
      db,
    );
    expect(out).toHaveProperty("unverified_excluded");
    expect(out.unverified_excluded).toBe(0);
  });

  it("the entity shortcut also reports an explicit zero", async () => {
    await ingest("x", "irrelevant");
    const res = await searchDocs(db, reader(), "PAY-4242", 10);
    expect(res.route).toBe("entity");
    expect(res).toHaveProperty("unverified_excluded");
    expect(res.unverified_excluded).toBe(0);
  });
});

describe("the vector arm withholds stale evidence too", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  /**
   * The query is deliberately LEXICALLY DISJOINT from the indexed text, so the
   * document can only arrive via the vector arm. Without that, the lexical arm
   * reaches it first and the test would pass while proving nothing about the
   * path it claims to cover — the vector arm was exactly the one shipping
   * unchecked snippets under a contract that said otherwise.
   */
  const seedAndEmbed = async (id: string, body: string) => {
    const { backfill } = await import("../embed/backfill.js");
    const { narrowEmbedder } = await import("./helpers/db.js");
    await upsertDocument(
      db,
      normalizeConfluence({
        id,
        title: `Doc ${id}`,
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
    await backfill(db, narrowEmbedder, { reembed: true });
    return narrowEmbedder;
  };

  it("withholds a vector-only chunk the document no longer contains, and counts it", async () => {
    const embedder = await seedAndEmbed("vec", "Zebra quokka marmot pangolin.");
    // Body moves; chunk_vectors and chunks keep the old text.
    await db.query("UPDATE documents SET body = $1 WHERE tenant = 'default' AND id = $2", [
      "Completely different content now.",
      "confluence:page:vec",
    ]);

    const hidden = await searchDocs(db, reader(), "xylophone trombone harpsichord", 10, embedder);
    const hiddenIds = (hidden.results as Array<{ id: string }>).map((r) => r.id);
    expect(hiddenIds).not.toContain("confluence:page:vec");

    const shown = await searchDocs(db, reader(), "xylophone trombone harpsichord", 10, embedder, {
      includeUnverified: true,
    });
    const hit = (shown.results as Array<{ id: string; evidence_verified?: boolean }>).find(
      (r) => r.id === "confluence:page:vec",
    );
    // Precondition: the vector arm really did reach it. If it did not, the
    // exclusion above proves nothing.
    expect(hit).toBeDefined();
    expect(hit?.evidence_verified).toBe(false);
    expect(Number(hidden.unverified_excluded)).toBeGreaterThan(0);
  });
});
