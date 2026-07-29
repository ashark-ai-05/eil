-- Two independent stores, both feeding step 5's scoring. Schema and backfill
-- only: no query uses these yet, because changing how results are RANKED needs
-- the eval gate and the labelled set is still empty.

-- ── BM25 apparatus ──────────────────────────────────────────────────────────
--
-- ts_rank has no IDF and no tf saturation, which is the single largest ranking
-- defect in the system: `work` counts exactly as much as `backoff`. Real BM25
-- needs three things, and Postgres already holds two of them —
-- `unnest(tsvector)` yields (lexeme, positions), so per-chunk term frequency is
-- array_length(positions,1). Only corpus-level document frequency is missing.
--
-- Refreshed on a schedule rather than per write. Staleness costs a little
-- ranking accuracy and never correctness, and the alternative — maintaining df
-- transactionally on every chunk write — would serialise ingestion on a single
-- hot row per lexeme.
CREATE TABLE lexeme_stats (
    lexeme       text PRIMARY KEY,
    df           bigint NOT NULL,
    refreshed_at timestamptz NOT NULL DEFAULT now()
);

-- Single row. N and avgdl are the other two BM25 inputs.
CREATE TABLE corpus_stats (
    only_row     boolean PRIMARY KEY DEFAULT true CHECK (only_row),
    n_chunks     bigint NOT NULL,
    avg_len      double precision NOT NULL,
    refreshed_at timestamptz NOT NULL DEFAULT now()
);

-- length(tsv) is the chunk's term count, the `dl` in BM25's length
-- normalisation. Stored rather than computed per query so scoring does not pay
-- for it on every candidate.
ALTER TABLE chunks ADD COLUMN len int;

-- ── Code tokenization ───────────────────────────────────────────────────────
--
-- Measured: to_tsvector('english', 'retryHandler') is 'retryhandl' — stemmed,
-- unsplittable — so `handler` matches nothing, and `src/retry/scheduler.py` is a
-- single opaque token that `scheduler.py` cannot reach. English also deletes
-- `if`, `for`, `do`, `no`, `on`, `is`, `t`, `s`, which are real code tokens.
--
-- code_tokens holds the expansion produced by ts/core/tokenize.ts — the whole
-- identifier plus its camel/acronym/digit parts, plus every path suffix. tsv_code
-- is GENERATED from it under `simple`, so the tsvector cannot drift from the
-- tokens it was built from; only one column is app-maintained instead of two.
ALTER TABLE chunks ADD COLUMN code_tokens text;
ALTER TABLE chunks ADD COLUMN tsv_code tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(code_tokens, ''))) STORED;
CREATE INDEX chunks_tsv_code_idx ON chunks USING gin (tsv_code);

-- ── Zoekt's ranking signals ─────────────────────────────────────────────────
--
-- How a term matched, so exact-vs-partial can be scored differently without a
-- trigram index. Nullable: existing rows predate the distinction and are
-- backfilled as 'exact', which is what they were.
ALTER TABLE code_index ADD COLUMN match_class text
  CHECK (match_class IN ('exact', 'subtoken', 'path_suffix', 'path_segment'));

-- Zoekt's generic symbol-kind factors, transcribed. The scorer multiplies by
-- 100, so this band is 100..1000 — an order of magnitude below the 4000/7000
-- symbol band, which is deliberate: WHAT matched matters more than what kind of
-- thing it is.
CREATE TABLE symbol_kind_factor (
    kind   text PRIMARY KEY,
    factor numeric(4,2) NOT NULL
);
INSERT INTO symbol_kind_factor (kind, factor) VALUES
    ('class', 10), ('struct', 9.5), ('enum', 9), ('interface', 8), ('type', 8),
    ('function', 7), ('method', 7), ('func', 7), ('def', 7),
    ('field', 5.5), ('const', 5), ('constant', 5), ('let', 4), ('var', 4);

-- Whole source lines were indexed as exact-match keys: `export` stored the
-- trimmed line, `literal` every quoted run. Nobody queries an exact trimmed
-- source line, so these rows could only ever be weight — and they are what drove
-- the btree-key-limit failures that made 23.4% of real files unindexable.
DELETE FROM code_index WHERE kind IN ('export', 'literal');
