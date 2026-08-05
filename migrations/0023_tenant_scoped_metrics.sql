-- Finish what 0009's tenant scoping started for the metrics views. 0009 made
-- (tenant, id)-style composite keys the identity boundary on documents,
-- chunks, links, sync_cursors and audit_log; 0018 already carried that
-- through to vw_connector_health (see its own comment on duplicate rows).
-- These four views were missed: they still group audit_log/usage_facts
-- across every tenant into one row, so a shared deployment cannot answer
-- "which tenant's connector died" or "what did tenant X cost" without
-- querying the raw tables directly.

-- usage_facts predates 0009 entirely and has no tenant column. Nothing in
-- the codebase writes to it yet (it is filled by an external collector/
-- gateway per its own "source" column comment), so this is a pure add, not
-- a backfill of ambiguous existing rows.
ALTER TABLE metrics.usage_facts ADD COLUMN tenant text NOT NULL DEFAULT 'default';
ALTER TABLE metrics.usage_facts DROP CONSTRAINT usage_facts_pkey;
ALTER TABLE metrics.usage_facts ADD PRIMARY KEY (day, tenant, principal, tool, source, model);

DROP VIEW metrics.vw_tool_calls;
CREATE VIEW metrics.vw_tool_calls AS
SELECT date_trunc('day', at)::date AS day, tenant, principal, tool, count(*) AS calls
FROM audit_log GROUP BY 1, 2, 3, 4;

DROP VIEW metrics.vw_zero_results;
CREATE VIEW metrics.vw_zero_results AS
SELECT date_trunc('day', at)::date AS day, tenant, tool,
       count(*) AS calls,
       count(*) FILTER (WHERE result_count = 0) AS zero_calls,
       round(count(*) FILTER (WHERE result_count = 0)::numeric / count(*), 3) AS zero_rate
FROM audit_log
WHERE tool IN ('search_docs', 'search_code')
GROUP BY 1, 2, 3;

DROP VIEW metrics.vw_two_phase;
CREATE VIEW metrics.vw_two_phase AS
SELECT date_trunc('day', at)::date AS day, tenant,
       count(*) FILTER (WHERE tool IN ('search_docs', 'search_code')) AS searches,
       count(*) FILTER (WHERE tool = 'get_doc') AS fetches,
       CASE WHEN count(*) FILTER (WHERE tool IN ('search_docs', 'search_code')) = 0 THEN NULL
            ELSE round(count(*) FILTER (WHERE tool = 'get_doc')::numeric
                       / count(*) FILTER (WHERE tool IN ('search_docs', 'search_code')), 3)
       END AS ratio
FROM audit_log GROUP BY 1, 2;

DROP VIEW metrics.vw_spend_daily;
CREATE VIEW metrics.vw_spend_daily AS
SELECT day, tenant, tool, unit, sum(quantity) AS quantity, sum(cost_usd) AS cost_usd
FROM metrics.usage_facts GROUP BY 1, 2, 3, 4;
