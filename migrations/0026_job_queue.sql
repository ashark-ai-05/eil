-- Durable job queue primitive. F5a: the queue only — nothing wires ingestion
-- or connector schedules onto it in this migration. That lands separately,
-- reviewed on its own, once this primitive itself is proven under real
-- Postgres concurrency (PGlite is one in-process connection and cannot
-- exercise FOR UPDATE SKIP LOCKED across two actual workers).

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  tenant text NOT NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  -- Tenant-scoped: the same idempotency key may legitimately be reused by
  -- two different tenants (e.g. "confluence:sync:daily"), and must not
  -- collide across them.
  idempotency_key text NOT NULL,
  -- No separate 'failed' state: a processing failure is never terminal on
  -- its own, only a decision between "retry" (back to pending) and
  -- "exhausted" (dead_letter) — a state nothing transitions into is a state
  -- that lies about what can happen.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'dead_letter')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  -- Incremented on every claim (including a reclaim of an expired lease).
  -- complete()/fail()/heartbeat() require the caller's fence_token to still
  -- match the row's current value — a worker whose lease already expired
  -- and was reclaimed by someone else holds a stale token and every one of
  -- its writes is rejected, even if it does not yet know its lease is gone.
  fence_token bigint NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  UNIQUE (tenant, idempotency_key)
);

-- Partial indexes matching exactly the two predicates claim() scans:
-- pending work ready to run, and claimed work whose lease has lapsed.
CREATE INDEX jobs_pending_idx ON jobs (run_after, id) WHERE status = 'pending';
CREATE INDEX jobs_expired_lease_idx ON jobs (lease_expires_at, id) WHERE status = 'claimed';
CREATE INDEX jobs_tenant_status_idx ON jobs (tenant, status);

-- Same conditional-grant pattern as 0025: local/PGlite catalogs have no
-- eil_connector_worker role and do not need one. The worker role is the
-- only one that touches the queue in this slice — no caller wires an
-- API-triggered enqueue path yet, so eil_api gets nothing here rather than
-- a grant nothing yet uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eil_connector_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON jobs TO eil_connector_worker;
    GRANT USAGE, SELECT ON SEQUENCE jobs_id_seq TO eil_connector_worker;
  END IF;
END
$$;
