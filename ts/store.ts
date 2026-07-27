/**
 * Catalog writes with the hash gate: unchanged content is a no-op.
 * Re-running a connector against an unchanged corpus writes nothing.
 */

import { userInfo } from "node:os";
import type pg from "pg";
import { type CanonicalDoc, chunkHash, contentHash } from "./contracts/models.js";
import { chunk } from "./core/chunker.js";

export async function getCursor(client: pg.Client, source: string): Promise<string | null> {
  const res = await client.query("SELECT cursor FROM sync_cursors WHERE source = $1", [source]);
  return res.rows[0]?.cursor ?? null;
}

export async function setCursor(client: pg.Client, source: string, cursor: string): Promise<void> {
  await client.query(
    "INSERT INTO sync_cursors (source, cursor) VALUES ($1, $2)" +
      " ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()",
    [source, cursor],
  );
}

/** Insert or update a document and its chunks/links. Returns true if content changed. */
export async function upsertDocument(client: pg.Client, doc: CanonicalDoc): Promise<boolean> {
  const hash = contentHash(doc);
  // FOR UPDATE serializes concurrent upserts of the same doc for the whole
  // transaction — without it, two workers can interleave the chunk
  // delete+insert below.
  const existing = await client.query(
    "SELECT content_hash, ingested_by FROM documents WHERE id = $1 FOR UPDATE",
    [doc.id],
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
     ON CONFLICT (id) DO UPDATE SET
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
  await client.query("DELETE FROM chunks WHERE doc_id = $1", [doc.id]);
  for (const c of chunk(doc)) {
    await client.query(
      "INSERT INTO chunks (doc_id, seq, heading_path, text, content_hash)" +
        " VALUES ($1, $2, $3, $4, $5)",
      [c.docId, c.seq, c.headingPath, c.text, chunkHash(c)],
    );
  }
  await client.query("DELETE FROM links WHERE src_id = $1", [doc.id]);
  for (const dst of doc.links) {
    await client.query(
      "INSERT INTO links (src_id, dst_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [doc.id, dst],
    );
  }
  return true;
}
