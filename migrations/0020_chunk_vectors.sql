-- migrations/0020_chunk_vectors.sql
-- One vector per EMBEDDER WINDOW, not one per chunk.
--
-- chunker.MAX_CHARS is 3200; the vendored MiniLM reads 1024. Everything past the
-- first window was embedded into nothing, silently: two 3200-char texts
-- differing only past ~1600 chars score cosine 1.000000 against each other.
-- quality.ts has counted the affected rows as chunks_over_embed_window since it
-- was written; nothing acted on the number.
--
-- chunks.embedding / .embed_model / .sig / .cluster_id are deliberately LEFT IN
-- PLACE. Dropping them would make a rollback require a full re-embed, and this
-- migration is meant to be reversible by pointing the read path back.
--
-- No backfill here: `eil embed backfill --reembed` fills this table, resumably.
-- A migration that UPDATEs the whole corpus is an outage, not a schema change.

CREATE TABLE chunk_vectors (
    tenant      text NOT NULL,
    doc_id      text NOT NULL,
    seq         int  NOT NULL,
    ord         int  NOT NULL,
    embedding   float4[] NOT NULL,
    embed_model text NOT NULL,
    sig         varbit,
    cluster_id  int,
    PRIMARY KEY (tenant, doc_id, seq, ord),
    FOREIGN KEY (tenant, doc_id, seq)
        REFERENCES chunks (tenant, doc_id, seq) ON DELETE CASCADE
);

-- Cluster probing filters on (tenant, cluster_id) exactly as chunks_ivf_idx did.
CREATE INDEX chunk_vectors_ivf_idx ON chunk_vectors (tenant, cluster_id);
-- The "is anything embedded with this model?" probe in vecArm.
CREATE INDEX chunk_vectors_model_idx ON chunk_vectors (tenant, embed_model);
