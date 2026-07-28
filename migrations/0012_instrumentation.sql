-- Step 0: make the system measurable. Every column here is nullable with no
-- default, so this is metadata-only in PG11+ — no table rewrite, brief lock.
--
-- The motivating defect: audit() ran AFTER the handler, so only SUCCESSES were
-- ever recorded. There was no duration column at all, which makes p95 not slow
-- to compute but unobtainable. And `route`/`executor` are already computed in
-- searchDocs and thrown away — persisting them costs nothing and is
-- simultaneously the latency story, the arm-contribution story, and the raw
-- material the eval harness replays.
ALTER TABLE audit_log ADD COLUMN duration_ms int;
ALTER TABLE audit_log ADD COLUMN ok boolean;
ALTER TABLE audit_log ADD COLUMN error text;
ALTER TABLE audit_log ADD COLUMN route text;
ALTER TABLE audit_log ADD COLUMN executor text;
ALTER TABLE audit_log ADD COLUMN trace_id text;
ALTER TABLE audit_log ADD COLUMN span_id text;

-- audit_log is the highest-volume table and had NO index on `at`, while every
-- metrics view groups by date_trunc('day', at). llm_calls got its index in 0002.
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE INDEX audit_log_trace_idx ON audit_log (trace_id) WHERE trace_id IS NOT NULL;

-- Same trace columns on llm_calls so a span can be joined from either fact table.
ALTER TABLE llm_calls ADD COLUMN trace_id text;
ALTER TABLE llm_calls ADD COLUMN span_id text;

-- Query -> results -> what the agent actually fetched afterwards. This is
-- simultaneously implicit relevance feedback, eval material, and the future
-- learning signal. Retention applies here as much as to audit_log; `eil prune`
-- covers both.
CREATE TABLE retrieval_events (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    trace_id   text NOT NULL,
    tenant     text NOT NULL,
    principal  text NOT NULL,
    query      text,
    route      text,
    executor   text,
    returned   jsonb NOT NULL DEFAULT '[]'   -- [{doc_id, rank, score}]
);
CREATE INDEX retrieval_events_trace_idx ON retrieval_events (trace_id);
CREATE INDEX retrieval_events_at_idx ON retrieval_events (at);

-- integrity() and drift() currently print JSON to stdout, so the best
-- data-health signals in the codebase have no trend and cannot be alerted on.
CREATE TABLE metrics.health_runs (
    id        bigserial PRIMARY KEY,
    at        timestamptz NOT NULL DEFAULT now(),
    kind      text NOT NULL CHECK (kind IN ('integrity', 'drift')),
    ok        boolean NOT NULL,
    report    jsonb NOT NULL
);
CREATE INDEX health_runs_kind_at_idx ON metrics.health_runs (kind, at DESC);

-- Latency and error rate, per tool and per day. Both were impossible before the
-- columns above existed. p95 via percentile_cont over the true population — not
-- a sampled estimate, which is the argument for keeping facts in Postgres.
CREATE VIEW metrics.vw_tool_latency AS
SELECT date_trunc('day', at) AS day,
       tool,
       count(*)::int AS calls,
       count(*) FILTER (WHERE ok IS FALSE)::int AS failures,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99_ms
  FROM audit_log
 WHERE duration_ms IS NOT NULL
 GROUP BY 1, 2;

-- Which arms actually contributed. `executor` names the arms that ran, so a
-- silently-missing vector arm (the most likely quality regression in the system)
-- becomes visible as a distribution shift rather than staying invisible.
CREATE VIEW metrics.vw_arm_mix AS
SELECT date_trunc('day', at) AS day,
       route,
       coalesce(executor, 'none') AS executor,
       count(*)::int AS calls
  FROM audit_log
 WHERE tool IN ('search_docs', 'search_code')
 GROUP BY 1, 2, 3;
