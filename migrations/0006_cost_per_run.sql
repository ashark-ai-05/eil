-- vw_cost_per_run (observability O-0): workflow runs are keyed by
-- llm_calls.caller until the orchestration plane lands; exact gateway cost
-- joins in at O-3 via usage_facts. Tokens/latency per caller-day is the
-- cost-per-run precursor the Model Performance board reads.
CREATE VIEW metrics.vw_cost_per_run AS
SELECT date_trunc('day', at)::date AS day,
       caller,
       count(*) AS llm_calls,
       sum(prompt_tokens) AS prompt_tokens,
       sum(completion_tokens) AS completion_tokens,
       sum(latency_ms) AS total_latency_ms,
       count(*) FILTER (WHERE NOT ok) AS failures
FROM llm_calls
GROUP BY 1, 2;
