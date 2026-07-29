-- Make the connector-rot tripwire actually fire.
--
-- The alert reads max(age_hours) from vw_connector_health, which derives from
-- sync_cursors.updated_at — and setCursor sets `updated_at = now()`
-- UNCONDITIONALLY, including on the failure-hold path where the cursor VALUE is
-- deliberately pinned. So a connector that runs hourly and fails every single
-- document correctly holds its cursor while resetting its freshness clock to
-- zero. The alert its own comment calls "the #1 connector-rot tripwire" stayed
-- green through exactly the rot it was built to catch.
--
-- Splitting the two clocks is the fix: `updated_at` keeps meaning "we wrote this
-- row", `last_success_at` means "a document actually landed". Only the second
-- can answer "has this connector silently died".
ALTER TABLE sync_cursors ADD COLUMN last_success_at timestamptz;
ALTER TABLE sync_cursors ADD COLUMN consecutive_failures int NOT NULL DEFAULT 0;
ALTER TABLE sync_cursors ADD COLUMN last_error text;

-- Existing rows have no history to distinguish the two, so seed from updated_at.
-- Optimistic by one interval at worst, and self-corrects on the next run.
UPDATE sync_cursors SET last_success_at = updated_at WHERE last_success_at IS NULL;

-- Two defects in one view. It selected `source` without `tenant`, so since the
-- composite key in 0009 it has emitted indistinguishable duplicate rows per
-- source — and quality.stale_sources reports those duplicates. And it measured
-- the wrong clock, per above.
DROP VIEW metrics.vw_connector_health;
CREATE VIEW metrics.vw_connector_health AS
SELECT tenant,
       source,
       cursor,
       updated_at,
       last_success_at,
       consecutive_failures,
       last_error,
       -- NULL rather than 0 when nothing has ever succeeded: a connector that
       -- has never worked is not "0 hours fresh". The alert treats NULL as
       -- alerting via noDataState, which is the honest reading.
       round((extract(epoch FROM now() - last_success_at) / 3600.0)::numeric, 2) AS age_hours
FROM sync_cursors;
