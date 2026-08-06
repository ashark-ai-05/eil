-- Documents that failed DURING an otherwise successful run.
--
-- `consecutive_failures` counts failed RUNS. It cannot see a run that listed
-- 4,000 files, failed to read 3 of them, and completed — and that run currently
-- calls setCursor with the default `{succeeded: true}`, so it records a fresh
-- `last_success_at`, a zero failure count, and a corpus reported as fully
-- current while three documents are silently absent from it.
--
-- That is the same shape as every other defect in this area: the absence of a
-- document reads as the absence of anything to find. The run-level flag is not
-- capable of expressing it, so the item-level count is stored beside it.
--
-- Last run, not cumulative. A total would only ever grow and could never
-- describe the CURRENT state of the corpus, which is the question an answer's
-- coverage is asking. A run that fixes the three unreadable files must be able
-- to report zero.
ALTER TABLE sync_cursors ADD COLUMN last_run_item_failures int NOT NULL DEFAULT 0;

-- Existing rows have no history to draw on. Zero is the honest default here
-- rather than NULL-as-unknown: every one of these rows was written by a run
-- that, under the old semantics, would have held the cursor had it failed
-- outright. It is not a claim that nothing ever failed, only that nothing is
-- known to have — and the next run of each connector overwrites it with a
-- measured value.

DROP VIEW metrics.vw_connector_health;
CREATE VIEW metrics.vw_connector_health AS
SELECT tenant,
       source,
       cursor,
       updated_at,
       last_success_at,
       consecutive_failures,
       last_run_item_failures,
       last_error,
       -- NULL rather than 0 when nothing has ever succeeded: a connector that
       -- has never worked is not "0 hours fresh". The alert treats NULL as
       -- alerting via noDataState, which is the honest reading.
       round((extract(epoch FROM now() - last_success_at) / 3600.0)::numeric, 2) AS age_hours
FROM sync_cursors;
