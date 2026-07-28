/** Embed chunks for the semantic arm. Embed-once: only NULL/stale rows unless
 *  --reembed. Provider errors abort (no partial-silent). */
import type { Db } from "../db.js";
import { type Embedder, packF32 } from "./index.js";

export async function backfill(
  client: Db,
  embedder: Embedder,
  opts: { batch?: number; reembed?: boolean },
): Promise<{ embedded: number }> {
  const batch = opts.batch ?? 64;
  const rows = (
    await client.query(
      opts.reembed
        ? "SELECT doc_id, seq, text FROM chunks ORDER BY doc_id, seq"
        : "SELECT doc_id, seq, text FROM chunks WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $1 ORDER BY doc_id, seq",
      opts.reembed ? [] : [embedder.id],
    )
  ).rows as Array<{ doc_id: string; seq: number; text: string }>;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const vecs = await embedder.embed(slice.map((r) => r.text));
    for (let j = 0; j < slice.length; j++) {
      await client.query(
        "UPDATE chunks SET embedding = $1, embed_model = $2 WHERE doc_id = $3 AND seq = $4",
        [packF32(vecs[j]!), embedder.id, slice[j]!.doc_id, slice[j]!.seq],
      );
      embedded += 1;
    }
    console.log(`  embedded ${Math.min(i + batch, rows.length)}/${rows.length}`);
  }
  return { embedded };
}
