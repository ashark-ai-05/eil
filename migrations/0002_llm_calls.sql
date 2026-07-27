-- Local LLM usage record. MaaS calls are also logged gateway-side (LiteLLM);
-- this table is the only telemetry for CLI-backed providers (amp, copilot),
-- whose dollar cost arrives separately via the F1 collectors.
CREATE TABLE llm_calls (
    id                bigserial PRIMARY KEY,
    at                timestamptz NOT NULL DEFAULT now(),
    provider          text NOT NULL,           -- maas | amp | copilot
    model             text,
    caller            text NOT NULL,           -- workflow/step name
    prompt_tokens     int,                     -- NULL when the backend doesn't report usage
    completion_tokens int,
    latency_ms        int,
    ok                boolean NOT NULL DEFAULT true
);

CREATE INDEX llm_calls_at_idx ON llm_calls (at);
CREATE INDEX llm_calls_caller_idx ON llm_calls (caller);
