-- Temporal validity: separate "when was this last edited" from "is this still
-- true". They are different facts and EIL only had the first.
--
-- An enterprise corpus is mostly superseded truth. The 2023 retry runbook is
-- often better written, more linked and more confidently phrased than the 2026
-- page that replaced it, so similarity plus recency ranks it first and the
-- agent acts on it. That failure is invisible to recall@k, because the stale
-- document genuinely IS topically relevant — it is the right subject and the
-- wrong answer.
--
-- updated_at cannot express this. A page can be edited today to add a banner
-- saying it is obsolete: recently updated, no longer valid.

ALTER TABLE documents ADD COLUMN valid_from timestamptz;
-- NULL valid_to means "still current". Set means the document describes a
-- state of the world that has ended.
ALTER TABLE documents ADD COLUMN valid_to timestamptz;
-- The document that replaced this one, when the source names it. Deliberately
-- NOT a foreign key: the successor may not be ingested yet, or ever, and a
-- dangling successor is better than refusing to record that one exists.
ALTER TABLE documents ADD COLUMN superseded_by text;

-- Backfill: everything currently in the catalog is treated as valid from when
-- it was created (falling back to last edit), and still current. That is the
-- status quo stated explicitly rather than a new claim — before this migration
-- every read behaved as though every document were current.
UPDATE documents SET valid_from = COALESCE(created_at, updated_at);

-- Retrieval filters on `valid_to IS NULL` in the hot path, so the partial index
-- covers exactly the rows a default query can return.
CREATE INDEX documents_current_idx ON documents (tenant, id) WHERE valid_to IS NULL;
