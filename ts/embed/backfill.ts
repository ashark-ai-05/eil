/** Embed chunks for the semantic arm, one vector per EMBEDDER WINDOW.
 *  Embed-once: only chunks with no current-model vectors unless --reembed.
 *  Provider errors abort (no partial-silent). */
import type { Db } from "../db.js";
import { type Embedder, toVec } from "./index.js";
import { embedWindows } from "./window.js";

export async function backfill(
  client: Db,
  embedder: Embedder,
  opts: { batch?: number; reembed?: boolean },
): Promise<{ embedded: number }> {
  const batch = opts.batch ?? 64;
  // tenant is part of the chunk identity since migration 0009 — (doc_id, seq) is
  // NO LONGER unique. Selecting and binding it is not cosmetic: the tenant-blind
  // write put one tenant's vector on every same-id chunk in every other tenant,
  // so a query phrased against tenant B's wording could surface tenant A's
  // document. Cross-tenant inference through the ranking channel.
  const rows = (
    await client.query(
      opts.reembed
        ? "SELECT tenant, doc_id, seq, heading_path, text FROM chunks ORDER BY tenant, doc_id, seq"
        : "SELECT c.tenant, c.doc_id, c.seq, c.heading_path, c.text FROM chunks c" +
            " WHERE NOT EXISTS (SELECT 1 FROM chunk_vectors v" +
            "   WHERE v.tenant = c.tenant AND v.doc_id = c.doc_id AND v.seq = c.seq" +
            "     AND v.embed_model = $1)" +
            " ORDER BY c.tenant, c.doc_id, c.seq",
      opts.reembed ? [] : [embedder.id],
    )
  ).rows as Array<{
    tenant: string;
    doc_id: string;
    seq: number;
    heading_path: string;
    text: string;
  }>;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    // The breadcrumb is composed back on for the EMBEDDING only, and onto every
    // window — it is real context for a vector, and it is why a window is
    // interpretable in isolation. It does not belong in stored text, where it
    // would be charged to every snippet.
    const perChunk = slice.map((r) => embedWindows(r.heading_path, r.text, embedder.windowChars));
    const flat = perChunk.flat();
    const vecs = await embedder.embed(flat);

    let k = 0;
    for (let j = 0; j < slice.length; j++) {
      const row = slice[j]!;
      const windows = perChunk[j]!;
      // Replace, never accumulate: a chunk that got shorter must not keep the
      // vectors of windows that no longer exist, or the vector arm would score
      // text the document no longer contains.
      //
      // Scoped by (tenant, doc_id, seq) ALONE, not also embed_model: the PK is
      // (tenant, doc_id, seq, ord), with no model column, so at most one
      // model's windows can occupy a given ord at a time — the same
      // one-vector-per-chunk constraint chunks.embedding always had. Scoping
      // the delete to only the model being written left a PRIOR model's rows
      // in place, and inserting ord 0 under the new model then collided with
      // them: "duplicate key value violates chunk_vectors_pkey".
      await client.query(
        "DELETE FROM chunk_vectors WHERE tenant = $1 AND doc_id = $2 AND seq = $3",
        [row.tenant, row.doc_id, row.seq],
      );
      for (let ord = 0; ord < windows.length; ord++) {
        await client.query(
          "INSERT INTO chunk_vectors (tenant, doc_id, seq, ord, embedding, embed_model)" +
            " VALUES ($1, $2, $3, $4, $5, $6)",
          [row.tenant, row.doc_id, row.seq, ord, toVec(vecs[k]!), embedder.id],
        );
        k += 1;
      }
      embedded += 1;
    }
    console.log(`  embedded ${Math.min(i + batch, rows.length)}/${rows.length} chunks`);
  }
  return { embedded };
}
