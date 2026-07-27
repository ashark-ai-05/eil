-- Observability plane O-0: metrics live where the facts already are.
-- Fact tables in a separate schema; metric definitions are SQL views —
-- versioned here, code-reviewed, and covered by tests/test_metrics.py.
CREATE SCHEMA metrics;

-- The one normalized cost table. Three vendor shapes reconciled honestly:
-- unit says what quantity means (usd | credits | seats | premium_requests);
-- cost_usd is filled only when the vendor actually bills in dollars.
CREATE TABLE metrics.usage_facts (
    day               date NOT NULL,
    principal         text NOT NULL,
    tool              text NOT NULL,      -- amp | copilot | maas
    source            text NOT NULL,      -- collector or gateway that produced the row
    model             text NOT NULL DEFAULT '',
    prompt_tokens     bigint,
    completion_tokens bigint,
    quantity          numeric(14, 4),
    unit              text NOT NULL DEFAULT 'usd',
    cost_usd          numeric(12, 4),
    PRIMARY KEY (day, principal, tool, source, model)
);

CREATE TABLE metrics.eval_runs (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    git_sha     text NOT NULL DEFAULT 'unknown',
    k           int NOT NULL,
    mean_recall numeric(5, 4) NOT NULL,
    queries     int NOT NULL,
    misses      jsonb NOT NULL DEFAULT '[]'
);

-- The sneaky-hard table: joins are only as good as this map.
CREATE TABLE metrics.identity_map (
    principal     text PRIMARY KEY,
    corp_email    text,
    github_handle text,
    amp_account   text,
    team          text
);

CREATE VIEW metrics.vw_tool_calls AS
SELECT date_trunc('day', at)::date AS day, principal, tool, count(*) AS calls
FROM audit_log GROUP BY 1, 2, 3;

CREATE VIEW metrics.vw_zero_results AS
SELECT date_trunc('day', at)::date AS day, tool,
       count(*) AS calls,
       count(*) FILTER (WHERE result_count = 0) AS zero_calls,
       round(count(*) FILTER (WHERE result_count = 0)::numeric / count(*), 3) AS zero_rate
FROM audit_log
WHERE tool IN ('search_docs', 'search_code')
GROUP BY 1, 2;

CREATE VIEW metrics.vw_llm_calls AS
SELECT date_trunc('day', at)::date AS day, provider, model, caller,
       count(*) AS calls,
       sum(prompt_tokens) AS prompt_tokens,
       sum(completion_tokens) AS completion_tokens,
       avg(latency_ms)::int AS avg_latency_ms,
       count(*) FILTER (WHERE NOT ok) AS failures
FROM llm_calls GROUP BY 1, 2, 3, 4;

CREATE VIEW metrics.vw_connector_health AS
SELECT source, cursor, updated_at,
       round((extract(epoch FROM now() - updated_at) / 3600.0)::numeric, 2) AS age_hours
FROM sync_cursors;

CREATE VIEW metrics.vw_eval_trend AS
SELECT at, at::date AS day, git_sha, k, mean_recall, queries
FROM metrics.eval_runs;

-- Two-phase ratio: get_doc calls per search. Near 1.0 = agents fetch
-- selectively as designed; >>1 = snippets too weak; ~0 = results not worth
-- opening.
CREATE VIEW metrics.vw_two_phase AS
SELECT date_trunc('day', at)::date AS day,
       count(*) FILTER (WHERE tool IN ('search_docs', 'search_code')) AS searches,
       count(*) FILTER (WHERE tool = 'get_doc') AS fetches,
       CASE WHEN count(*) FILTER (WHERE tool IN ('search_docs', 'search_code')) = 0 THEN NULL
            ELSE round(count(*) FILTER (WHERE tool = 'get_doc')::numeric
                       / count(*) FILTER (WHERE tool IN ('search_docs', 'search_code')), 3)
       END AS ratio
FROM audit_log GROUP BY 1;

CREATE VIEW metrics.vw_spend_daily AS
SELECT day, tool, unit, sum(quantity) AS quantity, sum(cost_usd) AS cost_usd
FROM metrics.usage_facts GROUP BY 1, 2, 3;
