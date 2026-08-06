/**
 * Raw artifact storage: keep the original bytes so extraction can be re-run
 * without going back to the source.
 *
 * Nothing here extracts anything. This slice makes bytes durable, deduplicated,
 * tenant-isolated and verifiable; PDF parsing, OCR and any retrieval surface are
 * deliberately out.
 *
 * Postgres `bytea` is the first default rather than the forever answer. It is
 * the only option `pg_dump` already captures, so the existing backup drill stays
 * complete by construction instead of by remembering to extend it — and a
 * correctness property maintained by discipline is one that eventually lapses.
 * The cost is real: backups grow by the whole artifact corpus, a single field
 * caps at 1GB, and PGlite holds each read in WASM memory. See the operational
 * note at the bottom of this file for when to move.
 */

import { createHash } from "node:crypto";
import type { Db, Tx } from "./db.js";

/**
 * Refusal for an artifact past the configured ceiling.
 *
 * A distinct type rather than a generic Error because the caller has to be able
 * to tell "too large, and that is a coverage gap to disclose" apart from "the
 * store is broken". The attachment connector does not exist yet; when it does,
 * it translates this into its per-source item-failure count. Deliberately no
 * counter is wired here — an inert path that pretends to record something is
 * the failure mode this codebase keeps finding.
 */
export class ArtifactTooLarge extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`artifact is ${size} bytes, over the ${limit}-byte ceiling`);
    this.name = "ArtifactTooLarge";
  }
}

/** Raised when stored bytes do not match the digest that names them. */
export class ArtifactCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCorrupt";
  }
}

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The size ceiling, from `EIL_ARTIFACT_MAX_BYTES`.
 *
 * Fails SAFE on anything unparseable — a typo yields the default, never
 * "unlimited". Getting this backwards would let a malformed env var silently
 * remove the only bound on how much a single document can push into the
 * catalog, which is the same absence-reads-as-permission shape as an ACL
 * defaulting to open.
 */
export function artifactMaxBytes(): number {
  const raw = Number(process.env.EIL_ARTIFACT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface StoredArtifact {
  digest: string;
  size: number;
  /** False when an identical blob was already present — publication is a no-op. */
  created: boolean;
}

/**
 * Store bytes, or confirm the identical bytes are already stored.
 *
 * Content-addressed, so re-publishing the same bytes is a no-op and the digest
 * cannot disagree with the content. On a digest collision the EXISTING row is
 * verified rather than trusted: `ON CONFLICT DO NOTHING` on its own would bless
 * a corrupted or truncated pre-existing row, and a store whose whole purpose is
 * faithful re-derivation cannot assume its own contents.
 */
export async function putArtifact(
  db: Tx,
  tenant: string,
  bytes: Buffer,
  opts: { maxBytes?: number } = {},
): Promise<StoredArtifact> {
  const limit = opts.maxBytes ?? artifactMaxBytes();
  if (bytes.length > limit) throw new ArtifactTooLarge(bytes.length, limit);

  const digest = sha256(bytes);
  const inserted = await db.query(
    "INSERT INTO artifacts (tenant, digest, size_bytes, bytes, storage)" +
      " VALUES ($1, $2, $3, $4, 'pg') ON CONFLICT (tenant, digest) DO NOTHING" +
      " RETURNING digest",
    [tenant, digest, bytes.length, bytes],
  );
  if (inserted.rows.length > 0) return { digest, size: bytes.length, created: true };

  // Already present: prove it is actually the same bytes before reporting
  // success. Length is checked from `octet_length` rather than the stored
  // `size_bytes` claim, because a claim beside the blob re-verifies nothing.
  const existing = await db.query(
    "SELECT octet_length(bytes) AS actual_len, size_bytes, bytes" +
      " FROM artifacts WHERE tenant = $1 AND digest = $2",
    [tenant, digest],
  );
  const row = existing.rows[0];
  if (!row) throw new ArtifactCorrupt(`artifact ${digest} vanished between insert and read`);
  const actualLen = Number(row.actual_len);
  if (actualLen !== bytes.length)
    throw new ArtifactCorrupt(
      `artifact ${digest} is ${actualLen} bytes on disk but ${bytes.length} were offered`,
    );
  if (Number(row.size_bytes) !== actualLen)
    throw new ArtifactCorrupt(
      `artifact ${digest} records size_bytes=${row.size_bytes} but holds ${actualLen} bytes`,
    );
  const storedDigest = sha256(Buffer.from(row.bytes));
  if (storedDigest !== digest)
    throw new ArtifactCorrupt(
      `artifact ${digest} holds bytes that hash to ${storedDigest} — stored content does not match its name`,
    );
  return { digest, size: actualLen, created: false };
}

/** Read stored bytes back, verifying they still hash to the name they are under. */
export async function getArtifact(db: Db, tenant: string, digest: string): Promise<Buffer> {
  const res = await db.query(
    "SELECT bytes, size_bytes, octet_length(bytes) AS actual_len" +
      " FROM artifacts WHERE tenant = $1 AND digest = $2",
    [tenant, digest],
  );
  const row = res.rows[0];
  if (!row) throw new ArtifactCorrupt(`artifact ${digest} not found in tenant ${tenant}`);
  // The same size check the write path makes. Detecting corruption only on a
  // digest conflict would mean the ordinary read — the one extraction actually
  // uses — serves corrupt bytes happily. The cost is negligible: the bytes are
  // already materialised in order to hash them.
  const actualLen = Number(row.actual_len);
  if (Number(row.size_bytes) !== actualLen)
    throw new ArtifactCorrupt(
      `artifact ${digest} records size_bytes=${row.size_bytes} but holds ${actualLen} bytes`,
    );
  const bytes = Buffer.from(row.bytes);
  const actual = sha256(bytes);
  // Verified on READ as well as on write: silent bit-rot in a store whose only
  // job is faithful re-derivation would otherwise surface as a mysteriously
  // different extraction months later.
  if (actual !== digest) throw new ArtifactCorrupt(`artifact ${digest} now hashes to ${actual}`);
  return bytes;
}

export interface ArtifactVersion {
  tenant: string;
  source: string;
  nativeId: string;
  revision: string;
  digest: string;
  docId: string;
  mediaType: string;
  filename?: string | null;
}

/**
 * Record where and when bytes were observed.
 *
 * Immutable by contract. Re-publishing the same coordinate with the same digest
 * and metadata is idempotent; the same coordinate with DIFFERENT content is a
 * hard conflict, never an update. A source that reuses a revision token for
 * changed content has violated its own versioning, and silently overwriting
 * would erase the evidence — the citation that pointed at the old bytes would
 * quietly start resolving to different ones.
 */
export async function linkArtifactVersion(
  db: Tx,
  v: ArtifactVersion,
): Promise<{ created: boolean }> {
  const inserted = await db.query(
    "INSERT INTO artifact_versions" +
      " (tenant, source, native_id, revision, digest, doc_id, media_type, filename)" +
      " VALUES ($1, $2, $3, $4, $5, $6, $7, $8)" +
      " ON CONFLICT (tenant, source, native_id, revision) DO NOTHING RETURNING revision",
    [
      v.tenant,
      v.source,
      v.nativeId,
      v.revision,
      v.digest,
      v.docId,
      v.mediaType,
      v.filename ?? null,
    ],
  );
  if (inserted.rows.length > 0) return { created: true };

  const existing = await db.query(
    "SELECT digest, doc_id, media_type, filename FROM artifact_versions" +
      " WHERE tenant = $1 AND source = $2 AND native_id = $3 AND revision = $4",
    [v.tenant, v.source, v.nativeId, v.revision],
  );
  const row = existing.rows[0];
  if (!row) throw new Error(`artifact version ${v.source}:${v.nativeId}@${v.revision} vanished`);
  const coord = `${v.source}:${v.nativeId}@${v.revision}`;
  if (row.digest !== v.digest)
    throw new Error(
      `${coord} already recorded with digest ${row.digest}; refusing to rebind it to ${v.digest}. A revision is immutable — changed content is a new revision.`,
    );
  if (row.doc_id !== v.docId)
    throw new Error(
      `${coord} already anchored to ${row.doc_id}; refusing to re-anchor to ${v.docId}`,
    );
  if (row.media_type !== v.mediaType)
    throw new Error(
      `${coord} already recorded as ${row.media_type}; refusing to change it to ${v.mediaType}`,
    );
  // Filename is source metadata about an immutable observation, so it conflicts
  // like the rest rather than being silently retained. Compared null-safely:
  // `undefined` and `null` both mean "the source reported no filename", and
  // treating them as different would make a caller that omits the field
  // conflict with one that passes null for the same observation.
  const priorName = (row.filename as string | null) ?? null;
  const nextName = v.filename ?? null;
  if (priorName !== nextName)
    throw new Error(
      `${coord} already recorded filename ${JSON.stringify(priorName)}; refusing to change it to ${JSON.stringify(nextName)}`,
    );
  return { created: false };
}

/**
 * Store bytes and record the observation in ONE transaction. The intended
 * connector entry point.
 *
 * `putArtifact` and `linkArtifactVersion` are two statements, and a failure
 * between them leaves a blob no observation references — invisible to the
 * caller, which believes it published nothing, and reachable only by the
 * collector. Worse, the lineage anchor and the bytes it anchors would land at
 * different commit boundaries, so a crash could produce a document whose
 * attachment exists in neither table nor in the source's next incremental
 * window.
 *
 * Participates in the CALLER's transaction: it never begins or commits one. On a
 * ceiling refusal or an immutability conflict it throws, and `withTransaction`
 * rolls back the whole unit — including whatever canonical work the caller did
 * alongside it. The lower-level functions remain exported as internal seams the
 * tests drive directly to exercise verification in isolation; a connector calls
 * this one, inside `withTransaction`.
 */
export async function publishArtifactVersion(
  tx: Tx,
  input: Omit<ArtifactVersion, "digest"> & { bytes: Buffer; maxBytes?: number },
): Promise<{ digest: string; blobCreated: boolean; versionCreated: boolean }> {
  const limit = input.maxBytes ?? artifactMaxBytes();
  if (input.bytes.length > limit) throw new ArtifactTooLarge(input.bytes.length, limit);
  const blob = await putArtifact(tx, input.tenant, input.bytes, { maxBytes: limit });
  const version = await linkArtifactVersion(tx, { ...input, digest: blob.digest });
  return { digest: blob.digest, blobCreated: blob.created, versionCreated: version.created };
}

/**
 * Retire one observation, and collect the bytes if nothing else references them.
 *
 * Retention is expressed on observations — but that model is only real if an
 * observation can actually be removed. With ON DELETE RESTRICT and no API for
 * this, every linked blob was permanent unless a caller reached past the module
 * with raw SQL, which is not a retention policy so much as an invitation to
 * corrupt the invariants this module exists to hold.
 *
 * Scoped to the FULL coordinate and the tenant. A partial coordinate would let
 * "retire this revision" silently retire every revision of the attachment, and
 * the tenant bound is the same reason it is on every other query here.
 *
 * One transaction: an observation removed without the collection attempt leaves
 * an orphan until someone remembers to sweep, and a sweep that ran outside the
 * delete could observe the row mid-flight.
 */
export async function retireArtifactVersion(
  tx: Tx,
  coord: { tenant: string; source: string; nativeId: string; revision: string },
): Promise<{ retired: boolean; collected: string[] }> {
  {
    const db = tx;
    const deleted = await db.query(
      "DELETE FROM artifact_versions" +
        " WHERE tenant = $1 AND source = $2 AND native_id = $3 AND revision = $4" +
        " RETURNING digest",
      [coord.tenant, coord.source, coord.nativeId, coord.revision],
    );
    if (deleted.rows.length === 0) return { retired: false, collected: [] };
    const digest = String(deleted.rows[0].digest);
    // Collect only THIS blob, and only if the last reference just went away.
    // A blanket sweep here would make retiring one attachment quietly delete
    // unrelated orphans, which is a different operation with a different risk.
    const collected = await db.query(
      "DELETE FROM artifacts a WHERE a.tenant = $1 AND a.digest = $2 AND NOT EXISTS (" +
        " SELECT 1 FROM artifact_versions v WHERE v.tenant = a.tenant AND v.digest = a.digest)" +
        " RETURNING a.digest",
      [coord.tenant, digest],
    );
    return { retired: true, collected: collected.rows.map((r: { digest: string }) => r.digest) };
  }
}

/** Every observation of one document's artifacts, newest first. */
export async function artifactsForDoc(
  db: Db,
  tenant: string,
  docId: string,
): Promise<ArtifactVersion[]> {
  const res = await db.query(
    "SELECT source, native_id, revision, digest, doc_id, media_type, filename" +
      " FROM artifact_versions WHERE tenant = $1 AND doc_id = $2" +
      " ORDER BY observed_at DESC, revision DESC",
    [tenant, docId],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    tenant,
    source: String(r.source),
    nativeId: String(r.native_id),
    revision: String(r.revision),
    digest: String(r.digest),
    docId: String(r.doc_id),
    mediaType: String(r.media_type),
    filename: (r.filename as string | null) ?? null,
  }));
}

/**
 * Delete blobs no observation references.
 *
 * Retention is expressed on OBSERVATIONS; bytes are collected only once nothing
 * points at them. The delete is guarded by `NOT EXISTS` and additionally by the
 * RESTRICT foreign key, so a version inserted concurrently either blocks this
 * delete or fails it — the collector cannot race a new reference into oblivion.
 */
export async function collectArtifactGarbage(db: Tx, tenant: string): Promise<string[]> {
  const res = await db.query(
    "DELETE FROM artifacts a WHERE a.tenant = $1 AND NOT EXISTS (" +
      " SELECT 1 FROM artifact_versions v WHERE v.tenant = a.tenant AND v.digest = a.digest)" +
      " RETURNING a.digest",
    [tenant],
  );
  return res.rows.map((r: { digest: string }) => r.digest);
}

/**
 * OPERATIONAL NOTE — `bytea` is the correct first default, not the scaling answer.
 *
 * Every artifact byte lands in the catalog, so `pg_dump` output grows with the
 * corpus and each backup copies all of it again. Rough shape: 10k attachments
 * averaging 2MB is ~20GB in the database and ~20GB per backup archive.
 *
 * Move off `bytea` when any of these is true, and treat them as the trigger to
 * build a real bundler rather than to widen the storage CHECK:
 *
 *   - the artifact corpus passes roughly 50GB, where dump/restore time starts
 *     dominating the operational drill;
 *   - backup storage cost or window becomes the binding constraint;
 *   - artifacts must be served directly to clients, where an object store's
 *     range reads and signed URLs matter and streaming out of Postgres does not
 *     compare.
 *
 * The migration path is deliberately not a config flip: `artifacts.storage` is a
 * CHECK-constrained closed discriminant, so adding a kind requires a migration
 * AND a backup path that can actually capture and verify those bytes. That
 * ordering is the point — an artifact store that pg_dump does not cover makes
 * the restore drill pass while the corpus is unrecoverable.
 */
