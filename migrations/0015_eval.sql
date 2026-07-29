-- The labelled set. Everything in the retrieval plan is gated on this existing,
-- which is why it lands before any ranking change.
--
-- The critical schema decision is that qrels key on DOCUMENT id, never on chunk
-- offset. Labelling at chunk granularity is the standard way people destroy an
-- eval set: the first re-chunk invalidates every judgment, and re-chunking is
-- exactly what steps 4-5 do.
CREATE TABLE eval_queries (
    id         bigserial PRIMARY KEY,
    query      text NOT NULL,
    tenant     text NOT NULL DEFAULT 'default',
    -- 'logged'   — replayed from real audit_log traffic (the good kind)
    -- 'authored' — written by hand against a known answer
    -- 'synthetic'— generated from a document
    -- Recorded so a synthetic-heavy set cannot silently masquerade as measured:
    -- a query generated from chunk C lexically echoes C, which inflates BM25 AND
    -- flatters whatever chunker produced C, so synthetic queries cannot be used
    -- to compare chunkers at all.
    origin     text NOT NULL CHECK (origin IN ('logged', 'authored', 'synthetic')),
    note       text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant, query)
);

CREATE TABLE eval_qrels (
    query_id  bigint NOT NULL REFERENCES eval_queries(id) ON DELETE CASCADE,
    doc_id    text NOT NULL,
    -- Graded 0-3 (UMBRELA-style), not binary. Pointwise grading is immune to the
    -- position bias that flips 10-30% of pairwise verdicts on reordering, and is
    -- O(pool) rather than O(pairs). Grade 0 is a real judgment — "judged and not
    -- relevant" is what makes judged@k meaningful.
    grade     smallint NOT NULL CHECK (grade BETWEEN 0 AND 3),
    judged_by text NOT NULL,
    judged_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (query_id, doc_id)
);
CREATE INDEX eval_qrels_doc_idx ON eval_qrels (doc_id);

-- Per-query results, so a regression can be attributed rather than just noticed.
-- metrics.eval_runs already stores the aggregate trend with a git sha.
CREATE TABLE metrics.eval_query_results (
    run_id     bigint NOT NULL REFERENCES metrics.eval_runs(id) ON DELETE CASCADE,
    query_id   bigint NOT NULL,
    recall_10  numeric(5,4),
    recall_50  numeric(5,4),
    ndcg_10    numeric(5,4),
    mrr        numeric(5,4),
    judged_10  numeric(5,4),
    returned   jsonb NOT NULL DEFAULT '[]',
    PRIMARY KEY (run_id, query_id)
);
