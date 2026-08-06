/**
 * The ingest runner's item contract.
 *
 * Two properties carry this slice, and both are about a single failure axis
 * having been asked to do two jobs:
 *
 *   - a HARD failure means the document did not land, so the cursor must hold
 *     and the next run must re-fetch it;
 *   - HEALTH DEBT means the document landed but related work did not, so the
 *     run is unhealthy and the cursor must STILL advance.
 *
 * Conflating them is not a cosmetic error. Debt that pinned the watermark would
 * make an unfixable related failure — an oversized attachment, say — re-fetch
 * the same window forever and advance nothing, which is precisely the livelock
 * the fatal-error handling in this file was written to eliminate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { type IngestItem, ingestDocs } from "../ingest/pipeline.js";
import { openTestDb } from "./helpers/db.js";

let db: Db;
beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await db.end();
});

const doc = (id: string, body = "body text", updated = "2026-03-01T00:00:00Z"): CanonicalDoc =>
  normalizeConfluence({
    id,
    title: `Page ${id}`,
    url: null,
    author: null,
    updated,
    created: updated,
    ancestors: ["ENG"],
    acl_groups: ["eng"],
    labels: [],
    body,
  } as never);

/** A fresh handle: ingestDocs opens and closes its own, and PGlite does not
 *  share writes across handles until one is reopened. */
const fresh = async <T>(fn: (c: Db) => Promise<T>): Promise<T> => {
  const c = await connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

const cursorRow = () =>
  fresh(async (c) => {
    const r = await c.query(
      "SELECT cursor, last_success_at, last_run_item_failures FROM sync_cursors WHERE source = 'confluence'",
    );
    return r.rows[0] ?? null;
  });

const docIds = () =>
  fresh(async (c) => {
    const r = await c.query("SELECT id FROM documents ORDER BY id");
    return r.rows.map((x: { id: string }) => x.id);
  });

const stamp = (d: CanonicalDoc) => d.updatedAt ?? null;

describe("bare CanonicalDoc input is unchanged", () => {
  it("ingests, advances the cursor, and reports a healthy run", async () => {
    await ingestDocs("confluence", [doc("a"), doc("b", "other", "2026-03-02T00:00:00Z")], stamp);
    expect(await docIds()).toEqual(["confluence:page:a", "confluence:page:b"]);
    const row = await cursorRow();
    expect(row.cursor).toContain("2026-03-02");
    expect(row.last_success_at).not.toBeNull();
    expect(row.last_run_item_failures).toBe(0);
  });

  it("a hard failure holds the cursor at the failing document", async () => {
    // A genuine DB-level violation: `documents.title` is NOT NULL, so this
    // fails in the store rather than in validation, which is the path a real
    // per-item failure takes.
    const broken = { ...doc("bad"), title: null } as unknown as CanonicalDoc;
    await ingestDocs("confluence", [doc("a"), broken], stamp);
    const row = await cursorRow();
    expect(row.last_success_at).toBeNull();
    expect(row.last_run_item_failures).toBeGreaterThan(0);
  });
});

describe("health debt lands the document and still advances the cursor", () => {
  const item = (id: string, healthDebt: number, updated: string): IngestItem => ({
    doc: doc(id, "body text", updated),
    healthDebt,
  });

  it("persists debt, marks the run unhealthy, and does NOT hold the watermark", async () => {
    await ingestDocs(
      "confluence",
      [item("a", 2, "2026-03-01T00:00:00Z"), item("b", 0, "2026-03-02T00:00:00Z")],
      stamp,
    );
    // Precondition: the documents really landed. Debt is about related work,
    // not about the document, so a missing document would prove nothing.
    expect(await docIds()).toEqual(["confluence:page:a", "confluence:page:b"]);

    const row = await cursorRow();
    // The cursor advanced to the LAST document, not held at the indebted one.
    expect(row.cursor).toContain("2026-03-02");
    // ...and the run is still unhealthy, with the debt persisted.
    expect(row.last_success_at).toBeNull();
    expect(row.last_run_item_failures).toBe(2);
  });

  it("rejects a debt value that is not a whole non-negative count", async () => {
    // NaN would vanish silently from every sum it entered.
    for (const bad of [Number.NaN, -1, 1.5]) {
      // Must fail THAT ITEM, not abort the listing: a malformed count from one
      // caller must not discard every other document in the run.
      await ingestDocs(
        "confluence",
        [{ doc: doc("x"), healthDebt: bad }, doc("ok", "b", "2026-03-05T00:00:00Z")],
        stamp,
      );
      const ids = await docIds();
      expect(ids).toContain("confluence:page:ok");
      expect(ids).not.toContain("confluence:page:x");
      const row = await cursorRow();
      expect(row?.last_success_at ?? null).toBeNull();
      await fresh((c) => c.query("DELETE FROM sync_cursors"));
      await fresh((c) => c.query("DELETE FROM documents"));
    }
  });
});

describe("related state commits with its parent", () => {
  it("runs the hook even when the parent text is unchanged", async () => {
    // Related state has its own lifecycle: an attachment can change while the
    // page body does not, so gating the hook on the parent hash would strand it.
    const d = doc("a");
    await ingestDocs("confluence", [d], stamp);
    let ran = 0;
    await ingestDocs(
      "confluence",
      [
        {
          doc: d,
          persistRelated: async () => {
            ran += 1;
          },
        },
      ],
      stamp,
    );
    expect(ran).toBe(1);
  });

  it("commits parent and related mutation together", async () => {
    await ingestDocs(
      "confluence",
      [
        {
          doc: doc("a"),
          persistRelated: async (tx) => {
            await tx.query(
              "INSERT INTO reconcile_runs (tenant, source, status, listed_count)" +
                " VALUES ('default', 'confluence', 'complete', 7)",
            );
          },
        },
      ],
      stamp,
    );
    expect(await docIds()).toEqual(["confluence:page:a"]);
    const runs = await fresh((c) =>
      c.query("SELECT listed_count FROM reconcile_runs").then((r) => r.rows),
    );
    expect(runs.map((r: { listed_count: number }) => r.listed_count)).toEqual([7]);
  });

  it("a hook failure rolls back the parent AND holds the cursor", async () => {
    // The half-applied write the single boundary exists to prevent: a page
    // committed without the state that was supposed to accompany it.
    await ingestDocs(
      "confluence",
      [
        {
          doc: doc("a"),
          persistRelated: async () => {
            throw new Error("related write failed");
          },
        },
      ],
      stamp,
    );
    expect(await docIds()).toEqual([]);
    const row = await cursorRow();
    // Hard failure: the watermark is pinned so the next run retries it.
    expect(row.cursor).toContain("2026-03-01");
    expect(row.last_success_at).toBeNull();
    expect(row.last_run_item_failures).toBe(1);
  });
});

describe("a fatal listing error keeps earned progress and rethrows", () => {
  it("records progress and debt, then rethrows the original error", async () => {
    const boom = new Error("listing aborted at page 40");
    async function* generator() {
      yield { doc: doc("a", "body text", "2026-03-01T00:00:00Z"), healthDebt: 3 } as IngestItem;
      throw boom;
    }
    // The ORIGINAL error must surface — an operator debugging a 429 must not be
    // handed a message about bookkeeping.
    await expect(ingestDocs("confluence", generator(), stamp)).rejects.toBe(boom);

    expect(await docIds()).toEqual(["confluence:page:a"]);
    const row = await cursorRow();
    // Progress earned before the abort is kept...
    expect(row.cursor).toContain("2026-03-01");
    // ...and the debt is persisted alongside the fatal outcome.
    expect(row.last_success_at).toBeNull();
    expect(row.last_run_item_failures).toBe(3);
  });
});
