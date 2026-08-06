/**
 * Real-PostgreSQL gate: PGlite cannot prove concurrency.
 *
 * The PGlite suite proves the MECHANISMS — the RESTRICT foreign key, the
 * `NOT EXISTS` guard, transactional rollback — but every one of its cases runs
 * sequentially on a single in-process connection. Two racing transactions are
 * not expressible there, and a test that serialises the operations while
 * calling itself concurrent would be worse than no test: it would license a
 * claim nothing had checked.
 *
 * This suite skips truthfully when no real Postgres is reachable, and the CI
 * gate below turns that skip into a failure where the drill is required.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectArtifactGarbage,
  linkArtifactVersion,
  publishArtifactVersion,
  putArtifact,
  sha256,
} from "../artifacts.js";
import { type Db, connect, migrate, withTransaction } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { upsertDocument } from "../store.js";

const DATABASE = "eil_ts_artifacts_concurrency";
const PDF = Buffer.from("%PDF-1.7 concurrent bytes");

/**
 * Transaction-wrapping helpers. The mutating APIs are transaction-scoped by
 * type now, so every call site would otherwise repeat `withTransaction`. These
 * keep the cases readable; the composition tests below use `withTransaction`
 * directly, because composition is the thing they are actually asserting.
 */
const txPut = (db: Db, tenant: string, bytes: Buffer, opts?: { maxBytes?: number }) =>
  withTransaction(db, (t) => putArtifact(t, tenant, bytes, opts ?? {}));
const txLink = (db: Db, v: Parameters<typeof linkArtifactVersion>[1]) =>
  withTransaction(db, (t) => linkArtifactVersion(t, v));
const txPublish = (db: Db, i: Parameters<typeof publishArtifactVersion>[1]) =>
  withTransaction(db, (t) => publishArtifactVersion(t, i));
const txCollect = (db: Db, tenant: string) =>
  withTransaction(db, (t) => collectArtifactGarbage(t, tenant));

let available = true;
let admin: Db;
let a: Db;
let b: Db;

try {
  admin = await connect("postgres");
} catch {
  available = false;
}

beforeAll(async () => {
  if (!available) return;
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  a = await connect(DATABASE);
  await migrate(a);
  // A SECOND connection is the entire point — one client cannot race itself.
  b = await connect(DATABASE);
});

afterAll(async () => {
  if (!available) return;
  await a?.end();
  await b?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.end();
});

const seed = (db: Db, id: string) =>
  upsertDocument(
    db,
    normalizeConfluence({
      id,
      title: `Page ${id}`,
      url: null,
      author: null,
      updated: "2026-03-01T00:00:00Z",
      created: "2026-03-01T00:00:00Z",
      ancestors: ["ENG"],
      acl_groups: ["eng"],
      labels: [],
      body: "body text",
    } as never),
  );

const publishInput = (over: Record<string, unknown> = {}) => ({
  tenant: "default",
  source: "confluence",
  nativeId: "att-1",
  revision: "1",
  docId: "confluence:page:a",
  mediaType: "application/pdf",
  bytes: PDF,
  ...over,
});

describe("real PostgreSQL artifact concurrency", () => {
  it("is available when the CI gate requires it", () => {
    if (process.env.EIL_REQUIRE_REAL_POSTGRES === "1") expect(available).toBe(true);
  });

  it.skipIf(!available)(
    "two identical publications race to exactly one blob and one observation",
    async () => {
      await a.query("DELETE FROM artifact_versions");
      await a.query("DELETE FROM artifacts");
      await a.query("DELETE FROM documents");
      await seed(a, "a");

      // Both start before either finishes. One wins the insert; the other must
      // find the existing rows, verify them, and report created:false — never
      // duplicate, never a unique-violation escaping to the caller.
      const [r1, r2] = await Promise.allSettled([
        txPublish(a, publishInput()),
        txPublish(b, publishInput()),
      ]);

      // At least one must succeed outright. A serialisation failure on the
      // loser is acceptable — a caller retries — but silent duplication is not.
      const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const blobs = await a.query("SELECT count(*)::int AS n FROM artifacts");
      const versions = await a.query("SELECT count(*)::int AS n FROM artifact_versions");
      expect(blobs.rows[0].n).toBe(1);
      expect(versions.rows[0].n).toBe(1);
    },
  );

  it.skipIf(!available)(
    "GC racing a new reference never leaves a dangling version or a missing blob",
    async () => {
      await a.query("DELETE FROM artifact_versions");
      await a.query("DELETE FROM artifacts");
      await a.query("DELETE FROM documents");
      await seed(a, "a");
      const { digest } = await txPut(a, "default", PDF);

      // The blob is orphaned at this instant, so the collector is entitled to
      // take it — while a connector is about to reference it. Either order is
      // legitimate; what must never happen is a version row pointing at bytes
      // that are gone, or a publication reporting success with no blob.
      const [link, gc] = await Promise.allSettled([
        txLink(b, {
          tenant: "default",
          source: "confluence",
          nativeId: "att-1",
          revision: "1",
          digest,
          docId: "confluence:page:a",
          mediaType: "application/pdf",
        }),
        txCollect(a, "default"),
      ]);

      const versions = await a.query("SELECT digest FROM artifact_versions");
      const blobs = await a.query("SELECT digest FROM artifacts");

      if (link.status === "fulfilled" && versions.rows.length > 0) {
        // Link won: the bytes it references MUST still be there. This is the
        // dangling-reference case the FK exists to prevent.
        expect(blobs.rows.map((r: { digest: string }) => r.digest)).toContain(digest);
      } else {
        // GC won: no version may survive pointing at collected bytes.
        expect(versions.rows).toHaveLength(0);
      }
      // Stated either way: never a version without its blob.
      for (const v of versions.rows as Array<{ digest: string }>)
        expect(blobs.rows.map((r: { digest: string }) => r.digest)).toContain(v.digest);
      expect(sha256(PDF)).toBe(digest);
    },
  );
});
