-- Store chunk text CLEAN; carry the breadcrumb separately.
--
-- chunks.text held `heading_path + "\n\n" + piece`, and both snippet paths read
-- that same column: ts_headline() over `text`, and String(row.text).slice(0,240)
-- in the vector arm. Every snippet therefore spent its opening characters on the
-- breadcrumb — measured at 9-16% of the 240-char vector snippet on a SHALLOW
-- fixture, and far worse on a real "Space > Team > Runbooks > Payments > Retry"
-- hierarchy. It also coupled renaming to re-embedding: because the breadcrumb
-- begins with the title, a page rename changed every chunk's text and so
-- invalidated every vector in that document.
--
-- Removing the prefix from `text` would silently drop title and space terms out
-- of the lexical index, since the prefix was the only thing putting them there.
-- So tsv is rebuilt over BOTH columns — and, since it has to be rebuilt anyway,
-- with setweight, which is free at index time and was simply never done:
--
--   A = heading_path   (title / space / section — the discriminative terms)
--   C = text           (body prose)
--
-- ts_rank's default weight array is {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}, so a title
-- match now outranks a body match instead of counting exactly the same. This is
-- the "title as a low-weight boost, not a component" finding from Onyx, which
-- weights title at 0.10 for precisely this reason: an irrelevant title
-- normalising to a perfect score is a known failure mode.
--
-- LOCK WARNING: a generated column's expression cannot be altered in place, so
-- this DROP + ADD rewrites the chunks table under ACCESS EXCLUSIVE. On a corpus
-- past ~1M chunks, run the staged path instead (see spec §11.4). Shipping it now
-- is deliberate: the change also forces a one-time re-embed, and that is cheapest
-- while corpora are small.
ALTER TABLE chunks DROP COLUMN tsv;
ALTER TABLE chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading_path, '')), 'A') ||
    setweight(to_tsvector('english', text), 'C')
  ) STORED;
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
