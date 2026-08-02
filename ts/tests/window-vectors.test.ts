import { beforeEach, describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import type { Embedder } from "../embed/index.js";
import { embedWindows } from "../embed/window.js";
import { searchDocs } from "../search.js";
import { narrowEmbedder, openTestDb, seedDoc, testViewer } from "./helpers/db.js";

const narrow = narrowEmbedder;

describe("window-grained embeddings", () => {
  let db: Awaited<ReturnType<typeof openTestDb>>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  it("writes more than one vector for a chunk longer than the window", async () => {
    await seedDoc(db, { id: "conf:1", text: "a".repeat(600), headingPath: "Page" });
    await backfill(db, narrow, { reembed: true });
    const n = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE doc_id = $1 AND seq = 0",
      ["conf:1"],
    );
    expect(n.rows[0].n).toBeGreaterThan(1);
  });

  it("numbers windows from zero, contiguously", async () => {
    await seedDoc(db, { id: "conf:1", text: "b".repeat(600), headingPath: "Page" });
    await backfill(db, narrow, { reembed: true });
    const r = await db.query(
      "SELECT ord FROM chunk_vectors WHERE doc_id = $1 AND seq = 0 ORDER BY ord",
      ["conf:1"],
    );
    expect(r.rows.map((x: any) => Number(x.ord))).toEqual(r.rows.map((_: unknown, i: number) => i));
  });

  it("distinguishes texts that differ only in their tail", async () => {
    await seedDoc(db, { id: "conf:head", text: `${"c".repeat(500)}ALPHA`, headingPath: "P" });
    await seedDoc(db, { id: "conf:tail", text: `${"c".repeat(500)}OMEGA`, headingPath: "P" });
    await backfill(db, narrow, { reembed: true });
    const r = await db.query(
      "SELECT doc_id, ord, embedding FROM chunk_vectors ORDER BY doc_id, ord",
    );
    const last = (doc: string) => {
      const rows = r.rows.filter((x: any) => x.doc_id === doc);
      return rows[rows.length - 1]!.embedding.map(Number);
    };
    const a = last("conf:head");
    const b = last("conf:tail");
    const cos = a.reduce((s: number, x: number, i: number) => s + x * b[i]!, 0);
    // The whole point: the differing tails must NOT embed to the same vector.
    expect(cos).toBeLessThan(0.999999);
  });

  it("replaces rather than accumulates on re-embed", async () => {
    await seedDoc(db, { id: "conf:1", text: "d".repeat(600), headingPath: "Page" });
    await backfill(db, narrow, { reembed: true });
    const first = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    await backfill(db, narrow, { reembed: true });
    const second = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    expect(second.rows[0].n).toBe(first.rows[0].n);
  });

  // I1 regression (task-2 review): the delete + N inserts for one chunk ran in
  // autocommit. A crash between the DELETE and the first INSERT left the chunk
  // with ZERO vectors; a crash mid-chunk left a PARTIAL window set that
  // embed-once could never repair, because NOT EXISTS sees SOME current-model
  // row and never revisits the seq. Both are now wrapped in one transaction
  // (mirrors ts/store.ts replaceCodeIndex) — a failure anywhere in the chunk
  // must roll back to nothing, and a plain re-run must pick it back up.
  it("rolls back an interrupted chunk instead of leaving a partial window set", async () => {
    await seedDoc(db, { id: "conf:1", text: "e".repeat(600), headingPath: "Page" });

    let inserts = 0;
    const flaky = {
      query: async (text: string, params?: any[]) => {
        if (text.startsWith("INSERT INTO chunk_vectors")) {
          inserts += 1;
          if (inserts === 2) throw new Error("simulated crash mid-chunk");
        }
        return db.query(text, params);
      },
      end: () => db.end(),
    };

    await expect(backfill(flaky, narrow, { reembed: true })).rejects.toThrow(
      "simulated crash mid-chunk",
    );
    // The ROLLBACK must undo the DELETE too — zero rows, not a partial set.
    const partial = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE doc_id = $1",
      ["conf:1"],
    );
    expect(partial.rows[0].n).toBe(0);

    // Resumable: a plain (non-reembed) run picks the chunk back up, because
    // NOT EXISTS finds no current-model row for it at all.
    const resumed = await backfill(db, narrow, {});
    expect(resumed.embedded).toBe(1);
    const after = await db.query("SELECT count(*)::int AS n FROM chunk_vectors WHERE doc_id = $1", [
      "conf:1",
    ]);
    expect(after.rows[0].n).toBeGreaterThan(1); // the FULL window set, not the one row before the crash
  });

  // I3 regression (task-2 review): the four tests above all target backfill();
  // none proves the read path's actual headline claim — that a match sitting
  // only in the TAIL of a long chunk, past the embedder's first window, can now
  // win a search. Under the pre-0020 single-vector-per-chunk scheme this term
  // was truncated away before it was ever embedded, so no query could surface
  // it via the vector arm. A small windowChars keeps the corpus cheap to force
  // multiple windows on.
  it("surfaces a document via a marker that exists only in its tail window", async () => {
    const headingPath = "Runbook";
    const text = `${"filler content ".repeat(20)}TAILMARKER`;
    // Sanity: the marker really is past window 0, i.e. this test would be
    // testing nothing under the old truncate-to-one-window behaviour.
    const windows = embedWindows(headingPath, text, 40);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]).not.toContain("TAILMARKER");
    expect(windows[windows.length - 1]).toContain("TAILMARKER");

    await seedDoc(db, { id: "conf:tail-match", text, headingPath });
    // An unrelated document so the corpus isn't a single trivial candidate.
    await seedDoc(db, {
      id: "conf:noise",
      text: "completely unrelated content about something else entirely",
      headingPath: "Other",
    });

    // A tiny window (forces the split cheaply) and a marker-keyed score, same
    // shape as the existing "vec arm fusion" stubs in embed.test.ts: exact
    // control over which window matches, so the assertion tests the SPLIT
    // rather than an accident of a hash-based fake embedder.
    const tailAware: Embedder = {
      id: "test:tail-aware",
      windowChars: 40,
      embed: async (texts: string[]) =>
        texts.map((t) =>
          t.includes("TAILMARKER") || t === "find the tail marker"
            ? Float32Array.from([1, 0, 0])
            : Float32Array.from([0, 1, 0]),
        ),
    };
    await backfill(db, tailAware, { reembed: true });

    // Lexically disjoint from both documents, so only the vector arm — and
    // specifically the tail window's vector — can surface conf:tail-match.
    const res: any = await searchDocs(db, testViewer(), "find the tail marker", 8, tailAware);
    expect((res.results as any[]).map((r) => r.id)).toContain("conf:tail-match");
  });
});
