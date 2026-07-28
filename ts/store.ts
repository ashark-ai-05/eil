/**
 * Catalog writes with the hash gate: unchanged content is a no-op.
 * Re-running a connector against an unchanged corpus writes nothing.
 */

import { userInfo } from "node:os";
import { type CanonicalDoc, chunkHash, contentHash, sha256 } from "./contracts/models.js";
import { chunk } from "./core/chunker.js";
import type { Db } from "./db.js";
import { extractCodeIndex } from "./ingest/codeindex.js";

export async function getCursor(
  client: Db,
  source: string,
  tenant = "default",
): Promise<string | null> {
  const res = await client.query(
    "SELECT cursor FROM sync_cursors WHERE tenant = $1 AND source = $2",
    [tenant, source],
  );
  return res.rows[0]?.cursor ?? null;
}

export async function setCursor(
  client: Db,
  source: string,
  cursor: string,
  tenant = "default",
): Promise<void> {
  await client.query(
    "INSERT INTO sync_cursors (tenant, source, cursor) VALUES ($1, $2, $3)" +
      " ON CONFLICT (tenant, source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()",
    [tenant, source, cursor],
  );
}

export interface SourceListing {
  ids: string[];
  /** Only an explicitly complete upstream listing may tombstone documents. */
  complete: boolean;
}
export interface ReconcileOutcome {
  status: "complete" | "incomplete";
  tombstoned: string[];
}

/**
 * A failed/partial listing is recorded but cannot mutate catalog visibility.
 * A complete listing tombstones missing documents for a quarantine period;
 * re-ingestion clears the tombstone, while purge is deliberately a separate
 * explicit retention operation.
 */
export async function reconcile(
  client: Db,
  source: string,
  listing: SourceListing,
  tenant = "default",
  actor?: string,
): Promise<ReconcileOutcome> {
  await client.query("BEGIN");
  try {
    if (!listing.complete) {
      await client.query(
        "INSERT INTO reconcile_runs (tenant, source, status, listed_count, actor) VALUES ($1, $2, 'incomplete', $3, $4)",
        [tenant, source, listing.ids.length, actor ?? null],
      );
      await client.query("COMMIT");
      return { status: "incomplete", tombstoned: [] };
    }
    const res = await client.query(
      "UPDATE documents SET tombstoned_at = now(), quarantine_until = now() + interval '7 days'" +
        " WHERE source = $1 AND tenant = $2 AND tombstoned_at IS NULL" +
        " AND NOT (id = ANY($3::text[])) RETURNING id",
      [source, tenant, listing.ids],
    );
    await client.query(
      "INSERT INTO reconcile_runs (tenant, source, status, listed_count, tombstoned_count, actor) VALUES ($1, $2, 'complete', $3, $4, $5)",
      [tenant, source, listing.ids.length, res.rows.length, actor ?? null],
    );
    await client.query("COMMIT");
    return { status: "complete", tombstoned: res.rows.map((r) => r.id as string) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function reconcileCodeRepo(
  client: Db,
  repo: string,
  ids: string[],
  tenant = "default",
): Promise<string[]> {
  const res = await client.query(
    "UPDATE documents SET tombstoned_at = now(), quarantine_until = now() + interval '7 days' WHERE tenant = $1 AND source = 'code' AND code_repo = $2 AND tombstoned_at IS NULL AND NOT (id = ANY($3::text[])) RETURNING id",
    [tenant, repo, ids],
  );
  return res.rows.map((r) => r.id as string);
}

/**
 * Insert or update a document and its chunks/links. Returns true if content
 * changed. Owns its transaction: FOR UPDATE only serializes concurrent
 * upserts if the lock survives past the SELECT, so the BEGIN/COMMIT lives
 * here rather than being an invisible caller obligation.
 */
export async function upsertDocument(client: Db, doc: CanonicalDoc): Promise<boolean> {
  await client.query("BEGIN");
  try {
    const changed = await upsertInTx(client, doc);
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function upsertInTx(client: Db, doc: CanonicalDoc): Promise<boolean> {
  const hash = contentHash(doc);
  const aclSnapshot = JSON.stringify(doc.aclGroups);
  const aclVersion = sha256(aclSnapshot);
  const existing = await client.query(
    "SELECT content_hash, acl_version, ingested_by, tombstoned_at FROM documents WHERE tenant = $1 AND id = $2 FOR UPDATE",
    [doc.tenant, doc.id],
  );
  const row = existing.rows[0];
  if (
    row &&
    row.content_hash === hash &&
    row.acl_version === aclVersion &&
    row.ingested_by &&
    !row.tombstoned_at
  ) {
    return false; // hash gate: nothing to do
  }
  // An empty ingested_by (pre-0003 rows) makes a doc invisible to everyone —
  // fail-closed but repairable: re-ingest falls through the gate and heals it.

  const write = await client.query(
    `INSERT INTO documents
        (id, tenant, source, title, url, author, created_at, updated_at,
         hierarchy, acl_groups, acl_snapshot, acl_version, quality_tier, content_hash, body, ingested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (tenant, id) DO UPDATE SET
        title = EXCLUDED.title, url = EXCLUDED.url, author = EXCLUDED.author,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
        hierarchy = EXCLUDED.hierarchy, acl_groups = EXCLUDED.acl_groups,
        acl_snapshot = EXCLUDED.acl_snapshot, acl_version = EXCLUDED.acl_version,
        quality_tier = EXCLUDED.quality_tier, content_hash = EXCLUDED.content_hash,
        body = EXCLUDED.body, ingested_at = now(), ingested_by = EXCLUDED.ingested_by,
        tombstoned_at = NULL, quarantine_until = NULL, revision = documents.revision + 1
     RETURNING revision`,
    [
      doc.id,
      doc.tenant,
      doc.source,
      doc.title,
      doc.url ?? null,
      doc.author ?? null,
      doc.createdAt ?? null,
      doc.updatedAt ?? null,
      JSON.stringify(doc.hierarchy),
      JSON.stringify(doc.aclGroups),
      aclSnapshot,
      aclVersion,
      doc.qualityTier,
      hash,
      doc.body,
      userInfo().username,
    ],
  );
  if (doc.codeRepo)
    await client.query(
      "UPDATE documents SET code_repo=$1, code_path=$2, code_ref=$3, code_language=$4, code_extractor_version=$5 WHERE tenant=$6 AND id=$7",
      [
        doc.codeRepo,
        doc.codePath ?? null,
        doc.codeRef ?? null,
        doc.codeLanguage ?? null,
        doc.codeExtractorVersion ?? null,
        doc.tenant,
        doc.id,
      ],
    );
  await client.query("DELETE FROM chunks WHERE tenant = $1 AND doc_id = $2", [doc.tenant, doc.id]);
  for (const c of chunk(doc)) {
    await client.query(
      "INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash)" +
        " VALUES ($1, $2, $3, $4, $5, $6)",
      [doc.tenant, c.docId, c.seq, c.headingPath, c.text, chunkHash(c)],
    );
  }
  await client.query("DELETE FROM links WHERE tenant = $1 AND src_id = $2", [doc.tenant, doc.id]);
  for (const dst of doc.links) {
    await client.query(
      "INSERT INTO links (tenant, src_id, dst_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [doc.tenant, doc.id, dst],
    );
  }
  await client.query(
    "INSERT INTO document_revisions (tenant, doc_id, revision, source, content_hash, acl_snapshot, acl_version) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [doc.tenant, doc.id, write.rows[0].revision, doc.source, hash, aclSnapshot, aclVersion],
  );
  return true;
}

/** Rebuild the deterministic, derived code projection for one indexed file/ref. */
export async function replaceCodeIndex(
  client: Db,
  doc: CanonicalDoc,
  repo: string,
  path: string,
  ref: string,
): Promise<void> {
  const entries = extractCodeIndex(path, doc.body);
  await client.query("DELETE FROM code_index WHERE tenant = $1 AND doc_id = $2", [
    doc.tenant,
    doc.id,
  ]);
  for (const e of entries)
    await client.query(
      "INSERT INTO code_index (tenant, doc_id, repo, path, ref, kind, value, raw_value, line_start, line_end, symbol_kind, language, extractor_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        doc.tenant,
        doc.id,
        repo,
        path,
        ref,
        e.kind,
        e.value,
        e.rawValue,
        e.lineStart,
        e.lineEnd,
        e.symbolKind ?? null,
        e.language,
        e.extractorVersion,
      ],
    );
}
