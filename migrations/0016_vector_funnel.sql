-- Sub-linear vector search in stock Postgres.
--
-- The exact float4[] dot product is O(N) with a per-row aggregate: measured
-- 298.5 us/chunk on PGlite, which is 5.9 s at 20k chunks and hours at the 20M
-- target. A bit-signature Hamming scan is 1.30 us/chunk (230x) and 0.17 us/chunk
-- once cluster probing narrows the candidate set (1750x), while the signature is
-- 30x smaller on disk: 1035 kB against 30 MB at 20k.
--
-- Two facts from measuring recall on real MiniLM vectors decided the shape:
--
--   * Binary quantization alone is NOT safe at 384 dimensions — 63.5% recall@10.
--     The published "~95% retention" figure is for 1024+ dims. Shipping
--     binary-only would have been a silent 36-point regression.
--   * With an exact rescore of the survivors, oversampling costs nothing and
--     buys nothing: 8x and 16x are IDENTICAL at every nprobe. All remaining loss
--     is clusters not probed. So oversample is fixed and nprobe is the knob.
--
-- nprobe is therefore NOT a constant in this schema or in the code. It is the
-- output of a calibration run with a recall gate, stored below, re-measured when
-- the corpus doubles.

-- varbit, not bit(384). A fixed width forces a schema migration the day a second
-- embedder with different dimensionality arrives, and the plan contemplates a
-- 768-dim code arm. XOR between different widths raises "cannot XOR bit strings
-- of different sizes" — but every query filters embed_model first, so widths are
-- uniform within any comparison, and the error is a loud failure rather than a
-- silent comparison across vector spaces.
ALTER TABLE chunks ADD COLUMN sig varbit;
ALTER TABLE chunks ADD COLUMN cluster_id int;

-- Partial: only embedded chunks are ever probed, so the index is the size of the
-- vector corpus rather than the whole chunk table.
CREATE INDEX chunks_ivf_idx ON chunks (tenant, cluster_id) WHERE embedding IS NOT NULL;

-- Keyed by embed_model so a model switch cannot silently mix vector spaces —
-- the same discipline chunks.embed_model already applies to the vectors.
CREATE TABLE ivf_centroids (
    embed_model text NOT NULL,
    cluster_id  int NOT NULL,
    centroid    float4[] NOT NULL,
    n_assigned  int NOT NULL DEFAULT 0,
    built_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (embed_model, cluster_id)
);

-- The calibration curve, persisted so the chosen nprobe is auditable rather than
-- folklore, and so CI can fail when a later run drops below the gate.
CREATE TABLE metrics.ivf_calibration (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    embed_model text NOT NULL,
    n_chunks    int NOT NULL,
    nlist       int NOT NULL,
    nprobe      int NOT NULL,
    oversample  int NOT NULL,
    recall_10   numeric(5,4) NOT NULL,
    queries     int NOT NULL,
    chosen      boolean NOT NULL DEFAULT false
);
CREATE INDEX ivf_calibration_model_at_idx ON metrics.ivf_calibration (embed_model, at DESC);
