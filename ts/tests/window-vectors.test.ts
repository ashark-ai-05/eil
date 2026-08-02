import { beforeEach, describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import { narrowEmbedder, openTestDb, seedDoc } from "./helpers/db.js";

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
});
