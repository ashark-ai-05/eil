/**
 * Catalog writes with the hash gate: unchanged content is a no-op.
 * Re-running a connector against an unchanged corpus writes nothing.
 */

import { userInfo } from "node:os";
import { type CanonicalDoc, chunkHash, contentHash } from "./contracts/models.js";
import { chunk } from "./core/chunker.js";
import type { Db } from "./db.js";

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

/**
 * Full-listing reconcile — the deletion story (design flow K1). A doc deleted
 * at the source never appears in an "updated since" query; only diffing a
 * complete id listing produces tombstones. Deletes catalog docs of `source`
 * (and tenant) absent from presentIds; chunks and outgoing links follow via
 * FK cascade. Returns the removed ids.
 */
export async function reconcile(
  client: Db,
  source: string,
  presentIds: string[],
  tenant = "default",
): Promise<string[]> {
  const res = await client.query(
    "DELETE FROM documents WHERE source = $1 AND tenant = $2" +
      " AND NOT (id = ANY($3::text[])) RETURNING id",
    [source, tenant, presentIds],
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
  const existing = await client.query(
    "SELECT content_hash, ingested_by FROM documents WHERE tenant = $1 AND id = $2 FOR UPDATE",
    [doc.tenant, doc.id],
  );
  const row = existing.rows[0];
  if (row && row.content_hash === hash && row.ingested_by) {
    return false; // hash gate: nothing to do
  }
  // An empty ingested_by (pre-0003 rows) makes a doc invisible to everyone —
  // fail-closed but repairable: re-ingest falls through the gate and heals it.

  await client.query(
    `INSERT INTO documents
        (id, tenant, source, title, url, author, created_at, updated_at,
         hierarchy, acl_groups, quality_tier, content_hash, body, ingested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tenant, id) DO UPDATE SET
        title = EXCLUDED.title, url = EXCLUDED.url, author = EXCLUDED.author,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
        hierarchy = EXCLUDED.hierarchy, acl_groups = EXCLUDED.acl_groups,
        quality_tier = EXCLUDED.quality_tier, content_hash = EXCLUDED.content_hash,
        body = EXCLUDED.body, ingested_at = now(),
        ingested_by = EXCLUDED.ingested_by`,
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
      doc.qualityTier,
      hash,
      doc.body,
      userInfo().username,
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
  return true;
}
