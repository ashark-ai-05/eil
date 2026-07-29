/** Embed chunks for the semantic arm. Embed-once: only NULL/stale rows unless
 *  --reembed. Provider errors abort (no partial-silent). */
import type { Db } from "../db.js";
import { type Embedder, toVec } from "./index.js";

export async function backfill(
  client: Db,
  embedder: Embedder,
  opts: { batch?: number; reembed?: boolean },
): Promise<{ embedded: number }> {
  const batch = opts.batch ?? 64;
  // tenant is part of the chunk identity since migration 0009 — (doc_id, seq) is
  // NO LONGER unique. Selecting and binding it is not cosmetic: the tenant-blind
  // UPDATE wrote one tenant's vector onto every same-id chunk in every other
  // tenant, so a query phrased against tenant B's wording could score and surface
  // tenant A's document. Cross-tenant inference through the ranking channel.
  const rows = (
    await client.query(
      opts.reembed
        ? "SELECT tenant, doc_id, seq, heading_path, text FROM chunks ORDER BY tenant, doc_id, seq"
        : "SELECT tenant, doc_id, seq, heading_path, text FROM chunks WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $1 ORDER BY tenant, doc_id, seq",
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
    // Compose the breadcrumb back on for the EMBEDDING only. The prefix is real
    // context for a vector — it is why a chunk is interpretable in isolation —
    // but it does not belong in stored text, where it would be charged to every
    // snippet and would tie every vector to the document's title.
    const vecs = await embedder.embed(
      slice.map((r) => (r.heading_path ? `${r.heading_path}\n\n${r.text}` : r.text)),
    );
    for (let j = 0; j < slice.length; j++) {
      await client.query(
        "UPDATE chunks SET embedding = $1, embed_model = $2 WHERE tenant = $3 AND doc_id = $4 AND seq = $5",
        [toVec(vecs[j]!), embedder.id, slice[j]!.tenant, slice[j]!.doc_id, slice[j]!.seq],
      );
      embedded += 1;
    }
    console.log(`  embedded ${Math.min(i + batch, rows.length)}/${rows.length}`);
  }
  return { embedded };
}
