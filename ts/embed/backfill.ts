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

  // A --reembed DELETEs and re-INSERTs every chunk_vectors row for this
  // model (below), so sig/cluster_id go NULL for the whole corpus at once —
  // but ivf_centroids and any `chosen` metrics.ivf_calibration row are
  // untouched and survive believing they still describe this data. Before
  // migration 0020, reembedding was an in-place `UPDATE chunks SET
  // embedding = ...` that left cluster_id alone, so a stale calibration
  // degraded gracefully: wrong geometry, but still non-NULL. The
  // one-vector-per-window rewrite can't preserve that — it inserts rows with
  // a NEW dimension (ord), it does not update existing ones. Left unfixed,
  // vecArm's `v.cluster_id = ANY($7)` filter (ts/search.ts) matches nothing
  // against an all-NULL corpus and the vector arm returns ZERO results,
  // silently, with no error: search quietly narrows to FTS-only. Superseding
  // here, before any chunk is touched, means the funnel falls back to the
  // exact scan (correct, just slow) for the WHOLE reembed, not only the
  // fraction already rewritten when a query happens to land mid-run — the
  // same fix as buildCentroids()'s supersede (NEW-4, fix round 2), applied
  // to the other place chunk_vectors' sig/cluster_id can go stale.
  if (opts.reembed) {
    await client.query(
      "UPDATE metrics.ivf_calibration SET superseded_at = now()" +
        " WHERE embed_model = $1 AND superseded_at IS NULL",
      [embedder.id],
    );
  }

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
      //
      // Transactional per chunk, matching replaceCodeIndex's delete+N-inserts
      // in ts/store.ts (same failure, same fix). In autocommit, a crash
      // between the DELETE and the first INSERT left the chunk with ZERO
      // vectors — worse than the single-column UPDATE this replaced, which
      // had no window where the old value was gone and the new one wasn't
      // there yet. A crash mid-chunk (after ord 0 landed) is worse still: the
      // embed-once NOT EXISTS check sees SOME current-model row for this seq
      // and never revisits it, so a partial window set — the tail of the
      // chunk permanently invisible to the vector arm — survives until a full
      // --reembed. Resumability is at chunk granularity, same as before this
      // task; it must not regress to window granularity.
      await client.query("BEGIN");
      try {
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
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      embedded += 1;
    }
    console.log(`  embedded ${Math.min(i + batch, rows.length)}/${rows.length} chunks`);
  }
  return { embedded };
}
