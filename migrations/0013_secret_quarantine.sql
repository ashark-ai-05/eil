-- Detect -> quarantine -> redact-on-serve.
--
-- Nullable, no default: metadata-only, no table rewrite.
--
-- The body is deliberately RETAINED. Destroying it would make a false positive
-- unrecoverable and leave nothing to show in a remediation worklist. Safety
-- comes from store.ts refusing to chunk or embed a quarantined document, so
-- the secret never reaches chunks.text, tsv, ts_headline, the vector snippet,
-- or an embedding — and from visibleSql() excluding it from every read path.
ALTER TABLE documents ADD COLUMN secret_findings jsonb;
ALTER TABLE documents ADD COLUMN quarantined_at timestamptz;

-- The remediation worklist: cheap to scan, and the partial predicate keeps the
-- index the size of the problem rather than the size of the corpus.
CREATE INDEX documents_quarantined_idx ON documents (tenant, source)
  WHERE quarantined_at IS NOT NULL;
