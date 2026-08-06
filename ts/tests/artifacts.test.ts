/**
 * Raw artifact storage (C2a).
 *
 * The store exists so extraction can be re-run without going back to the
 * source, which means its only real guarantee is that the bytes it returns are
 * the bytes it was given. Everything here is aimed at that: content addressing,
 * verification on both write and read, immutability of an observed revision,
 * and a collector that cannot delete something still referenced.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactCorrupt,
  ArtifactTooLarge,
  DEFAULT_MAX_BYTES,
  artifactMaxBytes,
  artifactsForDoc,
  collectArtifactGarbage,
  getArtifact,
  linkArtifactVersion,
  publishArtifactVersion,
  putArtifact,
  retireArtifactVersion,
  sha256,
} from "../artifacts.js";
import { type Db, type Tx, withTransaction } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { upsertDocument, upsertDocumentInTx } from "../store.js";
import { openTestDb } from "./helpers/db.js";

const PDF = Buffer.from("%PDF-1.7 pretend bytes");

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
const txRetire = (db: Db, c: Parameters<typeof retireArtifactVersion>[1]) =>
  withTransaction(db, (t) => retireArtifactVersion(t, c));
const txCollect = (db: Db, tenant: string) =>
  withTransaction(db, (t) => collectArtifactGarbage(t, tenant));

describe("bytes are stored, deduplicated and verified", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("addresses content by its own hash and round-trips exactly", async () => {
    const put = await txPut(db, "default", PDF);
    expect(put.digest).toBe(sha256(PDF));
    expect(put.size).toBe(PDF.length);
    expect(put.created).toBe(true);
    expect((await getArtifact(db, "default", put.digest)).equals(PDF)).toBe(true);
  });

  it("re-publishing identical bytes is a no-op, not a second row", async () => {
    const a = await txPut(db, "default", PDF);
    const b = await txPut(db, "default", PDF);
    expect(b.created).toBe(false);
    expect(b.digest).toBe(a.digest);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM artifacts");
    expect(rows[0].n).toBe(1);
  });

  it("one blob serves many observations rather than being copied per reference", async () => {
    // The dedup that makes `bytea` affordable: the same PDF attached to three
    // pages is one blob. Asserted on the table, not inferred from the API.
    await seedDoc(db, "a");
    await seedDoc(db, "b");
    const { digest } = await txPut(db, "default", PDF);
    for (const doc of ["a", "b"])
      await txLink(db, {
        tenant: "default",
        source: "confluence",
        nativeId: `att-${doc}`,
        revision: "1",
        digest,
        docId: `confluence:page:${doc}`,
        mediaType: "application/pdf",
      });
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(blobs.rows[0].n).toBe(1);
    expect(versions.rows[0].n).toBe(2);
  });

  it("refuses to bless a stored row whose bytes do not match its digest", async () => {
    // `ON CONFLICT DO NOTHING` alone would report success against a corrupted
    // or truncated pre-existing row. A store whose whole purpose is faithful
    // re-derivation cannot take its own contents on trust.
    const { digest } = await txPut(db, "default", PDF);
    await db.query("UPDATE artifacts SET bytes = $1 WHERE tenant = 'default' AND digest = $2", [
      Buffer.from("tampered"),
      digest,
    ]);
    await expect(txPut(db, "default", PDF)).rejects.toBeInstanceOf(ArtifactCorrupt);
  });

  it("detects corruption on read, not only on write", async () => {
    const { digest } = await txPut(db, "default", PDF);
    await db.query("UPDATE artifacts SET bytes = $1 WHERE tenant = 'default' AND digest = $2", [
      Buffer.from("%PDF-1.7 pretend bytez"),
      digest,
    ]);
    await expect(getArtifact(db, "default", digest)).rejects.toThrow(/hashes to/);
  });

  it("catches a size_bytes claim that disagrees with the stored bytes", async () => {
    // The claim beside the blob re-verifies nothing on its own; length is read
    // with octet_length so a wrong claim is caught rather than echoed.
    const { digest } = await txPut(db, "default", PDF);
    await db.query("UPDATE artifacts SET size_bytes = 999999 WHERE digest = $1", [digest]);
    await expect(txPut(db, "default", PDF)).rejects.toThrow(/size_bytes/);
  });

  it("rejects a size claim that disagrees with the bytes on an ORDINARY read", async () => {
    // The write path caught this only on a digest conflict, so a corrupted row
    // was served happily by the read that extraction actually uses. The bytes
    // are already materialised for hashing, so the check is free.
    const { digest } = await txPut(db, "default", PDF);
    await db.query("UPDATE artifacts SET size_bytes = 1 WHERE tenant = 'default' AND digest = $1", [
      digest,
    ]);
    await expect(getArtifact(db, "default", digest)).rejects.toThrow(/size_bytes/);
  });

  it("keeps tenants apart: the same bytes in two tenants are two rows", async () => {
    await txPut(db, "alpha", PDF);
    await txPut(db, "beta", PDF);
    const { rows } = await db.query("SELECT tenant FROM artifacts ORDER BY tenant");
    expect(rows.map((r: { tenant: string }) => r.tenant)).toEqual(["alpha", "beta"]);
    // And a digest is not readable across the boundary.
    await expect(getArtifact(db, "gamma", sha256(PDF))).rejects.toThrow(/not found/);
  });
});

describe("the size ceiling refuses rather than truncates", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("throws a typed refusal the caller can distinguish from a broken store", async () => {
    const big = Buffer.alloc(64, 1);
    const err = await txPut(db, "default", big, { maxBytes: 32 }).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactTooLarge);
    expect(err.size).toBe(64);
    expect(err.limit).toBe(32);
    // Nothing partial was written — a refusal must not leave a stub row that a
    // later read would treat as a stored artifact.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM artifacts");
    expect(rows[0].n).toBe(0);
  });

  it("an unparseable ceiling falls back to the default rather than to unlimited", () => {
    // Failing open here would silently remove the only bound on how much one
    // document can push into the catalog.
    const prev = process.env.EIL_ARTIFACT_MAX_BYTES;
    try {
      for (const bad of ["not-a-number", "", "-5", "0"]) {
        process.env.EIL_ARTIFACT_MAX_BYTES = bad;
        expect(artifactMaxBytes()).toBe(DEFAULT_MAX_BYTES);
      }
      process.env.EIL_ARTIFACT_MAX_BYTES = "1048576";
      expect(artifactMaxBytes()).toBe(1048576);
    } finally {
      if (prev === undefined) delete process.env.EIL_ARTIFACT_MAX_BYTES;
      else process.env.EIL_ARTIFACT_MAX_BYTES = prev;
    }
  });
});

describe("an observed revision is immutable and anchored", () => {
  let db: Db;
  // One hook: the seed and the blob are preconditions of every case below, so
  // splitting them across two beforeEach blocks only invites them to drift.
  beforeEach(async () => {
    db = await openTestDb();
    await seedDoc(db, "a");
    await txPut(db, "default", PDF);
  });
  afterEach(async () => {
    await db.end();
  });

  const link = (over: Partial<Parameters<typeof linkArtifactVersion>[1]> = {}) =>
    txLink(db, {
      tenant: "default",
      source: "confluence",
      nativeId: "att-1",
      revision: "1",
      digest: sha256(PDF),
      docId: "confluence:page:a",
      mediaType: "application/pdf",
      ...over,
    });

  it("re-publishing the identical observation is idempotent", async () => {
    expect((await link()).created).toBe(true);
    expect((await link()).created).toBe(false);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(rows[0].n).toBe(1);
  });

  it("rebinding a revision to different bytes is a hard conflict, never an update", async () => {
    // A source reusing a revision token for changed content has violated its
    // own versioning. Overwriting would make an existing citation quietly
    // resolve to different bytes than the ones it was checked against.
    await link();
    const other = Buffer.from("different content entirely");
    await txPut(db, "default", other);
    await expect(link({ digest: sha256(other) })).rejects.toThrow(/refusing to rebind/);
  });

  it("re-anchoring a revision to another document is refused", async () => {
    await seedDoc(db, "b");
    await link();
    await expect(link({ docId: "confluence:page:b" })).rejects.toThrow(/refusing to re-anchor/);
  });

  it("media type is per observation, so the same bytes may differ across sources", async () => {
    // The reason media_type lives on the version rather than the blob: hanging
    // it off the deduplicated row would make publication order-dependent.
    await link();
    await link({ source: "jira", nativeId: "att-j", mediaType: "application/octet-stream" });
    const rows = await db.query("SELECT source, media_type FROM artifact_versions ORDER BY source");
    expect(rows.rows.map((r: { media_type: string }) => r.media_type)).toEqual([
      "application/pdf",
      "application/octet-stream",
    ]);
    // ...and still exactly one blob.
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    expect(blobs.rows[0].n).toBe(1);
  });

  it("changing the recorded media type for one coordinate is refused", async () => {
    await link();
    await expect(link({ mediaType: "text/plain" })).rejects.toThrow(/refusing to change it/);
  });

  it("an observation cannot exist without a canonical parent", async () => {
    // doc_id is the ACL anchor: an orphan artifact is a document with no
    // permissions to inherit, which is the one shape a future read path must
    // never encounter.
    await expect(link({ docId: "confluence:page:nonexistent" })).rejects.toThrow();
  });

  it("lists a document's artifacts", async () => {
    await link();
    const found = await artifactsForDoc(db, "default", "confluence:page:a");
    expect(found.map((f) => f.nativeId)).toEqual(["att-1"]);
    expect(found[0]?.mediaType).toBe("application/pdf");
  });
});

describe("garbage collection cannot delete something still referenced", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("collects an unreferenced blob", async () => {
    const { digest } = await txPut(db, "default", PDF);
    expect(await txCollect(db, "default")).toEqual([digest]);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM artifacts");
    expect(rows[0].n).toBe(0);
  });

  it("leaves a referenced blob alone", async () => {
    await seedDoc(db, "a");
    const { digest } = await txPut(db, "default", PDF);
    await txLink(db, {
      tenant: "default",
      source: "confluence",
      nativeId: "att-1",
      revision: "1",
      digest,
      docId: "confluence:page:a",
      mediaType: "application/pdf",
    });
    expect(await txCollect(db, "default")).toEqual([]);
    expect((await getArtifact(db, "default", digest)).equals(PDF)).toBe(true);
  });

  it("the foreign key blocks deleting bytes out from under an observation", async () => {
    // Belt and braces: the collector's NOT EXISTS is the intended guard, but a
    // direct or concurrent delete must also be refused rather than cascading
    // into a dangling reference. RESTRICT is what makes that structural.
    await seedDoc(db, "a");
    const { digest } = await txPut(db, "default", PDF);
    await txLink(db, {
      tenant: "default",
      source: "confluence",
      nativeId: "att-1",
      revision: "1",
      digest,
      docId: "confluence:page:a",
      mediaType: "application/pdf",
    });
    await expect(
      db.query("DELETE FROM artifacts WHERE tenant = 'default' AND digest = $1", [digest]),
    ).rejects.toThrow();
  });

  it("deleting the parent document is refused while observations remain", async () => {
    // ON DELETE RESTRICT rather than SET NULL: losing the anchor would strand
    // an artifact with no permissions to inherit. Callers remove observations
    // explicitly, in order.
    await seedDoc(db, "a");
    const { digest } = await txPut(db, "default", PDF);
    await txLink(db, {
      tenant: "default",
      source: "confluence",
      nativeId: "att-1",
      revision: "1",
      digest,
      docId: "confluence:page:a",
      mediaType: "application/pdf",
    });
    await expect(
      db.query("DELETE FROM documents WHERE tenant = 'default' AND id = 'confluence:page:a'"),
    ).rejects.toThrow();
  });

  it("collects only within the requested tenant", async () => {
    await txPut(db, "alpha", PDF);
    await txPut(db, "beta", PDF);
    expect(await txCollect(db, "alpha")).toHaveLength(1);
    const left = await db.query("SELECT tenant FROM artifacts");
    expect(left.rows.map((r: { tenant: string }) => r.tenant)).toEqual(["beta"]);
  });
});

describe("the storage discriminant is closed at the schema", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("rejects a storage kind pg_dump would not capture", async () => {
    // The safety boundary is a CHECK constraint, not an adapter's self-reported
    // boolean. Adding 'file' or 'object' must require a migration AND a backup
    // path that can capture those bytes — not a config value someone flips.
    await expect(
      db.query(
        "INSERT INTO artifacts (tenant, digest, size_bytes, bytes, storage)" +
          " VALUES ('default', 'deadbeef', 3, NULL, 'object')",
      ),
    ).rejects.toThrow();
  });

  it("rejects a pg row with no bytes", async () => {
    await expect(
      db.query(
        "INSERT INTO artifacts (tenant, digest, size_bytes, bytes, storage)" +
          " VALUES ('default', 'deadbeef', 0, NULL, 'pg')",
      ),
    ).rejects.toThrow();
  });
});

/** Transaction-scoped seed: composing inside a caller's transaction is the
 *  whole point of that suite, and the standalone upsert would open a nested
 *  one — committing the outer transaction early, which is the bug under test. */
async function seedDocInTx(tx: Tx, id: string): Promise<void> {
  await upsertDocumentInTx(tx, docFixture(id));
}

function docFixture(id: string) {
  return normalizeConfluence({
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
  } as never);
}

async function seedDoc(db: Db, id: string): Promise<void> {
  await upsertDocument(
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
}

describe("publication is atomic", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
    await seedDoc(db, "a");
  });
  afterEach(async () => {
    await db.end();
  });

  const input = (over: Record<string, unknown> = {}) => ({
    tenant: "default",
    source: "confluence",
    nativeId: "att-1",
    revision: "1",
    docId: "confluence:page:a",
    mediaType: "application/pdf",
    bytes: PDF,
    ...over,
  });

  it("stores bytes and records the observation in one call", async () => {
    const out = await txPublish(db, input());
    expect(out.digest).toBe(sha256(PDF));
    expect(out.blobCreated).toBe(true);
    expect(out.versionCreated).toBe(true);
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(blobs.rows[0].n).toBe(1);
    expect(versions.rows[0].n).toBe(1);
  });

  it("a failure linking the observation leaves NEITHER row", async () => {
    // The orphan-blob case. Two independent statements would leave bytes behind
    // that the caller believes it never published — invisible except to the
    // collector. An absent parent makes the link fail after the blob insert,
    // which is exactly the window under test.
    await expect(txPublish(db, input({ docId: "confluence:page:missing" }))).rejects.toThrow();
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(blobs.rows[0].n).toBe(0);
    expect(versions.rows[0].n).toBe(0);
  });

  it("an immutability conflict rolls back rather than half-applying", async () => {
    await txPublish(db, input());
    const other = Buffer.from("different bytes entirely");
    await expect(txPublish(db, input({ bytes: other }))).rejects.toThrow(/refusing to rebind/);
    // The conflicting run must not have left its new blob behind.
    const blobs = await db.query("SELECT digest FROM artifacts");
    expect(blobs.rows.map((r: { digest: string }) => r.digest)).toEqual([sha256(PDF)]);
  });

  it("republishing the identical artifact is idempotent end to end", async () => {
    await txPublish(db, input());
    const again = await txPublish(db, input());
    expect(again.blobCreated).toBe(false);
    expect(again.versionCreated).toBe(false);
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(blobs.rows[0].n).toBe(1);
    expect(versions.rows[0].n).toBe(1);
  });

  it("refuses an oversized artifact without opening a transaction", async () => {
    await expect(
      txPublish(db, input({ bytes: Buffer.alloc(64, 1), maxBytes: 32 })),
    ).rejects.toBeInstanceOf(ArtifactTooLarge);
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    expect(blobs.rows[0].n).toBe(0);
  });
});

describe("retention is expressible through the API", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
    await seedDoc(db, "a");
    await seedDoc(db, "b");
  });
  afterEach(async () => {
    await db.end();
  });

  const publish = (over: Record<string, unknown> = {}) =>
    txPublish(db, {
      tenant: "default",
      source: "confluence",
      nativeId: "att-1",
      revision: "1",
      docId: "confluence:page:a",
      mediaType: "application/pdf",
      bytes: PDF,
      ...over,
    });

  const coord = (over: Record<string, unknown> = {}) => ({
    tenant: "default",
    source: "confluence",
    nativeId: "att-1",
    revision: "1",
    ...over,
  });

  it("retiring one of two observations preserves the shared blob", async () => {
    await publish();
    await publish({ nativeId: "att-2", docId: "confluence:page:b" });
    const out = await txRetire(db, coord());
    expect(out.retired).toBe(true);
    expect(out.collected).toEqual([]);
    // The bytes survive because the second observation still needs them.
    expect((await getArtifact(db, "default", sha256(PDF))).equals(PDF)).toBe(true);
  });

  it("retiring the last observation collects the bytes", async () => {
    await publish();
    const out = await txRetire(db, coord());
    expect(out.retired).toBe(true);
    expect(out.collected).toEqual([sha256(PDF)]);
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    expect(blobs.rows[0].n).toBe(0);
  });

  it("a coordinate that does not exist retires nothing rather than erroring", async () => {
    await publish();
    const out = await txRetire(db, coord({ revision: "99" }));
    expect(out.retired).toBe(false);
    expect(out.collected).toEqual([]);
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(versions.rows[0].n).toBe(1);
  });

  it("cannot retire another tenant's observation", async () => {
    await publish();
    const out = await txRetire(db, coord({ tenant: "beta" }));
    expect(out.retired).toBe(false);
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect(versions.rows[0].n).toBe(1);
  });

  it("a partial coordinate cannot retire a sibling revision", async () => {
    // Scoped to the FULL coordinate: "retire this revision" must not become
    // "retire every revision of this attachment".
    await publish();
    await publish({ revision: "2" });
    const out = await txRetire(db, coord({ revision: "2" }));
    expect(out.retired).toBe(true);
    const left = await db.query("SELECT revision FROM artifact_versions");
    expect(left.rows.map((r: { revision: string }) => r.revision)).toEqual(["1"]);
  });

  it("retiring does not collect unrelated orphans", async () => {
    // A blanket sweep inside a targeted retire would quietly delete bytes the
    // caller never mentioned — a different operation with a different risk.
    await publish();
    const orphan = Buffer.from("nobody references me");
    await txPut(db, "default", orphan);
    const out = await txRetire(db, coord());
    expect(out.collected).toEqual([sha256(PDF)]);
    const left = await db.query("SELECT digest FROM artifacts");
    expect(left.rows.map((r: { digest: string }) => r.digest)).toEqual([sha256(orphan)]);
  });
});

describe("filename is immutable source metadata like the rest", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
    await seedDoc(db, "a");
    await txPut(db, "default", PDF);
  });
  afterEach(async () => {
    await db.end();
  });

  const link = (over: Record<string, unknown> = {}) =>
    txLink(db, {
      tenant: "default",
      source: "confluence",
      nativeId: "att-1",
      revision: "1",
      digest: sha256(PDF),
      docId: "confluence:page:a",
      mediaType: "application/pdf",
      ...over,
    });

  it("a changed filename is a hard conflict, not a silently retained old value", async () => {
    await link({ filename: "policy.pdf" });
    await expect(link({ filename: "policy-v2.pdf" })).rejects.toThrow(/refusing to change it/);
  });

  it("omitted and null mean the same thing, so neither conflicts with the other", async () => {
    // Null-safe on purpose: a caller that omits the field and one that passes
    // null are describing the same observation, and making those conflict would
    // turn an API convenience into a spurious failure.
    await link();
    expect((await link({ filename: null })).created).toBe(false);
    expect((await link({ filename: undefined })).created).toBe(false);
  });

  it("adding a filename where none was recorded conflicts", async () => {
    await link();
    await expect(link({ filename: "late.pdf" })).rejects.toThrow(/refusing to change it/);
  });
});

describe("artifact work composes inside a caller's transaction", () => {
  /**
   * The blocker this closes: `publishArtifactVersion` used to issue its own
   * BEGIN/COMMIT on whatever `Db` it was handed. PostgreSQL transactions do not
   * nest, so a connector already writing the canonical document atomically
   * would have had its transaction COMMITTED early by the artifact call, and
   * ROLLED BACK — losing unrelated work — if the artifact failed.
   *
   * These assert the composed boundary, not artifact-local atomicity, which is
   * what the earlier tests already covered.
   */
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const input = (over: Record<string, unknown> = {}) => ({
    tenant: "default",
    source: "confluence",
    nativeId: "att-1",
    revision: "1",
    docId: "confluence:page:a",
    mediaType: "application/pdf",
    bytes: PDF,
    ...over,
  });

  it("writes the parent document and the artifact under ONE commit", async () => {
    await withTransaction(db, async (t) => {
      await seedDocInTx(t, "a");
      await publishArtifactVersion(t, input());
    });
    const docs = await db.query("SELECT count(*)::int AS n FROM documents");
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect([docs.rows[0].n, blobs.rows[0].n, versions.rows[0].n]).toEqual([1, 1, 1]);
  });

  it("a throw AFTER publication rolls back the canonical work too", async () => {
    // The composition case. Previously the artifact call had already COMMITTED
    // by this point, so the document would vanish while the blob survived —
    // exactly inverted from what the caller asked for.
    await expect(
      withTransaction(db, async (t) => {
        await seedDocInTx(t, "a");
        await publishArtifactVersion(t, input());
        throw new Error("caller failed after publishing");
      }),
    ).rejects.toThrow(/caller failed/);

    const docs = await db.query("SELECT count(*)::int AS n FROM documents");
    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect([docs.rows[0].n, blobs.rows[0].n, versions.rows[0].n]).toEqual([0, 0, 0]);
  });

  it("an artifact conflict rolls back the caller's unrelated work", async () => {
    await withTransaction(db, async (t) => {
      await seedDocInTx(t, "a");
      await publishArtifactVersion(t, input());
    });
    // Second transaction: write a NEW document, then hit an immutability
    // conflict. The new document must not survive.
    await expect(
      withTransaction(db, async (t) => {
        await seedDocInTx(t, "b");
        await publishArtifactVersion(t, input({ bytes: Buffer.from("different bytes") }));
      }),
    ).rejects.toThrow(/refusing to rebind/);
    const docs = await db.query("SELECT id FROM documents ORDER BY id");
    expect(docs.rows.map((r: { id: string }) => r.id)).toEqual(["confluence:page:a"]);
  });

  it("a throw after retirement restores both the observation and the blob", async () => {
    await withTransaction(db, async (t) => {
      await seedDocInTx(t, "a");
      await publishArtifactVersion(t, input());
    });
    await expect(
      withTransaction(db, async (t) => {
        const out = await retireArtifactVersion(t, {
          tenant: "default",
          source: "confluence",
          nativeId: "att-1",
          revision: "1",
        });
        // Precondition: the retire really did happen inside this transaction,
        // so the restoration below is the rollback and not a no-op.
        expect(out.retired).toBe(true);
        expect(out.collected).toEqual([sha256(PDF)]);
        throw new Error("caller failed after retiring");
      }),
    ).rejects.toThrow(/caller failed/);

    const blobs = await db.query("SELECT count(*)::int AS n FROM artifacts");
    const versions = await db.query("SELECT count(*)::int AS n FROM artifact_versions");
    expect([blobs.rows[0].n, versions.rows[0].n]).toEqual([1, 1]);
  });

  it("a rollback failure does not replace the original error", async () => {
    // Cleanup must not become the reported cause. A dead connection during
    // ROLLBACK would otherwise hide the defect behind its own side effect.
    const flaky: Db = {
      query: async (text: string) => {
        if (text === "ROLLBACK") throw new Error("connection lost during rollback");
        return { rows: [] };
      },
      end: async () => {},
    };
    await expect(
      withTransaction(flaky, async () => {
        throw new Error("the real cause");
      }),
    ).rejects.toThrow(/the real cause/);
  });
});
