/**
 * Retention purge for quarantine-expired documents.
 *
 * This replaces a bare `DELETE FROM documents`. That statement was correct while
 * a document was the only thing that referenced itself, but artifact_versions
 * now points at documents with ON DELETE RESTRICT, so the bare delete would
 * simply ERROR once any attachment existed — retention would stop running and
 * the failure would look like a database problem rather than a policy one.
 *
 * RESTRICT was chosen deliberately over CASCADE: an artifact is the original
 * evidence behind a citation, and a cascade would let a routine catalog delete
 * silently take the evidence with it. The cost of that choice is that deletion
 * order becomes explicit, which is what this module owns.
 *
 * Everything happens in ONE transaction. A purge that removed artifact versions
 * and then failed to remove their documents would leave documents whose
 * evidence had been destroyed — a worse state than either endpoint.
 */

import { type Tx, type TxHost, withTransaction } from "./db.js";

export interface PurgeOutcome {
  /** Documents whose quarantine window has closed. */
  documents: number;
  /** Attachment references removed because their parent document went away. */
  artifactVersions: number;
  /**
   * Blobs deleted because their LAST reference went away.
   *
   * Lower than `artifactVersions` whenever a blob was deduplicated: identical
   * bytes attached to two pages are stored once, and purging one page must not
   * remove the bytes the other page still cites.
   */
  artifactBlobs: number;
  /** Bytes released by those blobs — the number an operator actually plans around. */
  artifactBytes: number;
  /** Tenants touched; the GC sweep is per-tenant because the key is composite. */
  tenants: string[];
}

/**
 * A candidate document changed state after it was locked and before it was
 * deleted. Aborts the purge rather than completing it half-applied.
 */
export class PurgeRaced extends Error {
  constructor(
    readonly expected: number,
    readonly deleted: number,
  ) {
    super(
      `purge raced: locked ${expected} expired document(s) but deleted ${deleted}; rolling back so their attachments survive`,
    );
    this.name = "PurgeRaced";
  }
}

/** Thrown to force a ROLLBACK once a dry run has measured the real work. */
class DryRunComplete extends Error {
  constructor(readonly outcome: PurgeOutcome) {
    super("dry run");
  }
}

/**
 * Delete documents past their quarantine window, and the artifacts they own.
 *
 * `dryRun` reports exactly what a real run would do by DOING it and rolling
 * back, rather than by predicting it with counting queries. A prediction is a
 * second implementation of the delete's semantics and can disagree with the
 * first — most damagingly by reporting success for work a constraint would
 * actually refuse. Rolling back a real attempt cannot disagree with itself.
 */
export async function purgeExpiredQuarantine(
  host: TxHost,
  opts: { dryRun?: boolean } = {},
): Promise<PurgeOutcome> {
  try {
    return await withTransaction(host, async (tx) => {
      const outcome = await purgeInTx(tx);
      if (opts.dryRun) throw new DryRunComplete(outcome);
      return outcome;
    });
  } catch (err) {
    if (err instanceof DryRunComplete) return err.outcome;
    throw err;
  }
}

async function purgeInTx(tx: Tx): Promise<PurgeOutcome> {
  // Not scoped to a tenant. Retention is a compliance obligation that runs for
  // everyone; scoping it to the caller's tenant would silently leave every other
  // tenant's expired bodies on disk while the command still reported success.
  //
  // FOR UPDATE, and ordered. Without the lock a concurrent re-ingest can clear
  // the tombstone in the window between retiring this document's attachments
  // and deleting the document: the guarded delete then correctly spares the
  // restored row, and the restore silently comes back with its evidence gone.
  // That is the worst outcome available here — a live document whose citations
  // resolve to nothing — and it is invisible, because both statements did
  // exactly what they were told. ORDER BY makes the lock order deterministic so
  // two purges cannot deadlock against each other.
  const expired = await tx.query(
    "SELECT tenant, id FROM documents" +
      " WHERE tombstoned_at IS NOT NULL" +
      " AND quarantine_until IS NOT NULL AND quarantine_until < now()" +
      " ORDER BY tenant, id FOR UPDATE",
  );
  const docs = expired.rows as Array<{ tenant: string; id: string }>;
  if (docs.length === 0)
    return { documents: 0, artifactVersions: 0, artifactBlobs: 0, artifactBytes: 0, tenants: [] };

  const tenants = [...new Set(docs.map((d) => d.tenant))].sort();
  const keyTenants = docs.map((d) => d.tenant);
  const keyIds = docs.map((d) => d.id);

  // Versions first: the FK is RESTRICT, so the document delete below fails
  // outright while any reference survives.
  //
  // The pairing is by (tenant, id) TOGETHER, and here that is load-bearing
  // rather than decorative. This statement has no expiry predicate of its own,
  // so matching on doc_id alone would delete another tenant's attachment
  // whenever a document id collided — leaving that tenant's document alive and
  // citing bytes that no longer exist. Mutating the tenant term away fails
  // "does not reach across tenants when ids collide".
  const versions = await tx.query(
    "DELETE FROM artifact_versions v USING unnest($1::text[], $2::text[]) AS k(tenant, id)" +
      " WHERE v.tenant = k.tenant AND v.doc_id = k.id RETURNING v.tenant, v.digest",
    [keyTenants, keyIds],
  );

  // The expiry predicate is re-stated here rather than trusted from the SELECT
  // above, so a row that changed underneath us is not deleted on stale grounds.
  // That re-check also makes this statement's tenant term defence in depth
  // rather than load-bearing — dropping it fails no test, and the comment says
  // so instead of implying coverage that does not exist.
  const removed = await tx.query(
    "DELETE FROM documents d USING unnest($1::text[], $2::text[]) AS k(tenant, id)" +
      " WHERE d.tenant = k.tenant AND d.id = k.id" +
      " AND d.tombstoned_at IS NOT NULL" +
      " AND d.quarantine_until IS NOT NULL AND d.quarantine_until < now() RETURNING d.id",
    [keyTenants, keyIds],
  );

  // The lock above should make this impossible. It is checked anyway, because
  // the failure it guards against is silent: fewer documents deleted than we
  // just stripped evidence from means one was restored underneath us, and
  // finishing the transaction would leave a live document whose citations
  // resolve to nothing. Aborting puts the attachments back.
  if (removed.rows.length !== docs.length) throw new PurgeRaced(docs.length, removed.rows.length);

  // Sweep last, and ONLY over the digests this purge released.
  //
  // A tenant-wide sweep was wrong twice over: it deleted pre-existing orphan
  // blobs that had nothing to do with these documents, and it then reported
  // them as bytes this purge freed. Retention that quietly removes unrelated
  // data — and misattributes it in its own report — is worse than retention
  // that removes too little, because the report is what an operator trusts.
  //
  // NOT EXISTS is still required: a released digest may be deduplicated with a
  // surviving document's attachment, and those bytes must stay.
  // Keyed by (tenant, digest) together: a digest is only unique within a
  // tenant, so collapsing to a bare digest list would let one tenant's purge
  // delete an identical blob belonging to another.
  const released = [
    ...new Map(
      (versions.rows as Array<{ tenant: string; digest: string }>).map((r) => [
        `${r.tenant}\u0000${r.digest}`,
        r,
      ]),
    ).values(),
  ].sort((a, b) => (a.tenant + a.digest < b.tenant + b.digest ? -1 : 1));
  let artifactBlobs = 0;
  let artifactBytes = 0;
  if (released.length > 0) {
    const collected = await tx.query(
      "DELETE FROM artifacts a USING unnest($1::text[], $2::text[]) AS k(tenant, digest)" +
        " WHERE a.tenant = k.tenant AND a.digest = k.digest AND NOT EXISTS (" +
        " SELECT 1 FROM artifact_versions v WHERE v.tenant = a.tenant AND v.digest = a.digest)" +
        " RETURNING a.size_bytes",
      [released.map((r) => r.tenant), released.map((r) => r.digest)],
    );
    artifactBlobs = collected.rows.length;
    artifactBytes = (collected.rows as Array<{ size_bytes: number }>).reduce(
      (n, r) => n + Number(r.size_bytes),
      0,
    );
  }

  return {
    documents: removed.rows.length,
    artifactVersions: versions.rows.length,
    artifactBlobs,
    artifactBytes,
    tenants,
  };
}

/**
 * Hard-delete one document, refusing if it still owns evidence.
 *
 * The repository-code path deletes a document outright when its file disappears
 * from the tree, and code documents carry no attachments — so this is a
 * contract, not a live hazard. Contracts of that shape are exactly the ones that
 * quietly stop holding: the day some source attaches an artifact to a `code:`
 * document, a bare DELETE would either destroy the evidence or fail with an
 * opaque constraint name from inside a loop.
 *
 * Refusing by name instead says which invariant broke and where.
 */
export async function hardDeleteDocument(host: TxHost, tenant: string, id: string): Promise<void> {
  await withTransaction(host, async (tx) => {
    const held = await tx.query(
      "SELECT count(*)::int AS n FROM artifact_versions WHERE tenant = $1 AND doc_id = $2",
      [tenant, id],
    );
    const n = Number(held.rows[0]?.n ?? 0);
    if (n > 0)
      throw new Error(
        `refusing to hard-delete ${id}: ${n} artifact version(s) still reference it. Retire them through the retention purge, which preserves the quarantine window.`,
      );
    await tx.query("DELETE FROM documents WHERE id = $1 AND tenant = $2", [id, tenant]);
  });
}
