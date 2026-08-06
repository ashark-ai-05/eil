-- Durable citation locators for filesystem-sourced chunks.
--
-- A heading path cannot locate a citation. Markdown repeats headings freely, so
-- "Setup > Install" may name three places in one document, and a renderer slug
-- is not portable — every renderer generates them differently, so a fragment
-- that resolves in one viewer silently resolves nowhere in another.
--
-- The durable locator is the canonical relative path plus an exact 1-based line
-- range: it is what a human opens an editor at, and it survives both repeated
-- headings and any change of renderer.
--
-- All three columns are NULLABLE and unset for every existing source. Confluence
-- and Jira documents have no meaningful source line numbers — their bodies are
-- converted from XHTML — so a line range there would be fabricated precision.
-- Absent is the honest value.
--
-- Chunk identity is deliberately untouched: `chunkHash` is sha256(text) alone,
-- so these columns cannot perturb it, and existing chunks are neither rewritten
-- nor re-embedded by this migration.
ALTER TABLE chunks ADD COLUMN source_path text;
ALTER TABLE chunks ADD COLUMN line_start int;
ALTER TABLE chunks ADD COLUMN line_end   int;

-- All THREE together or none at all. Coupling only the two line numbers still
-- permitted a range with no file to open, and a path with no range — both of
-- which look like a precise anchor and resolve nowhere.
ALTER TABLE chunks ADD CONSTRAINT chunks_line_span_complete
  CHECK (
    (source_path IS NULL AND line_start IS NULL AND line_end IS NULL)
    OR (source_path IS NOT NULL AND line_start IS NOT NULL AND line_end IS NOT NULL)
  );
ALTER TABLE chunks ADD CONSTRAINT chunks_line_span_ordered
  CHECK (line_start IS NULL OR (line_start >= 1 AND line_end >= line_start));
