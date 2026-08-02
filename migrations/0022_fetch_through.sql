-- migrations/0022_fetch_through.sql
-- Snippet sufficiency, as a number.
--
-- vw_two_phase divides get_doc CALLS by search CALLS. That is a useful shape
-- metric but it saturates: one fetch after a ten-result search reads the same as
-- ten. The cost question is what FRACTION OF RETURNED RESULTS the agent could
-- not act on from the snippet alone — that is the number a wider snippet is
-- supposed to move, so it is the number to watch when tuning SNIPPET_OPTS.

CREATE VIEW metrics.vw_fetch_through AS
SELECT date_trunc('day', at)::date AS day,
       sum(result_count) FILTER (WHERE tool IN ('search_docs', 'search_code')) AS results_returned,
       count(*) FILTER (WHERE tool = 'get_doc') AS fetches,
       CASE WHEN coalesce(sum(result_count) FILTER (WHERE tool IN ('search_docs', 'search_code')), 0) = 0
            THEN NULL
            ELSE round(count(*) FILTER (WHERE tool = 'get_doc')::numeric
                       / sum(result_count) FILTER (WHERE tool IN ('search_docs', 'search_code')), 3)
       END AS fetch_through
FROM audit_log GROUP BY 1;
