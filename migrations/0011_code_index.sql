-- ASH-72 deterministic code retrieval projection. Documents remain the ACL source of truth.
ALTER TABLE documents ADD COLUMN code_repo text;
ALTER TABLE documents ADD COLUMN code_path text;
ALTER TABLE documents ADD COLUMN code_ref text;
ALTER TABLE documents ADD COLUMN code_language text;
ALTER TABLE documents ADD COLUMN code_extractor_version text;

CREATE TABLE code_index (
  tenant text NOT NULL,
  doc_id text NOT NULL,
  repo text NOT NULL,
  path text NOT NULL,
  ref text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('path','symbol','literal','import','export','test')),
  value text NOT NULL,
  raw_value text NOT NULL,
  line_start integer NOT NULL,
  line_end integer NOT NULL,
  symbol_kind text,
  language text NOT NULL,
  extractor_version text NOT NULL,
  PRIMARY KEY (tenant, doc_id, kind, value, line_start, line_end),
  FOREIGN KEY (tenant, doc_id) REFERENCES documents(tenant, id) ON DELETE CASCADE
);
-- Leading columns must match what searchCodeIndex actually pins: tenant + value
-- (+ optional kind). Putting repo/ref first made the index unusable for every
-- query the product issues — neither the MCP tool nor search.ts supplies them —
-- so the planner inverted the join and probed code_index_pkey once PER VISIBLE
-- DOCUMENT. Measured at 200k rows / 20k docs: 245 ms and 60k buffers, scaling
-- with the document count rather than the match count.
CREATE INDEX code_index_lookup_idx ON code_index (tenant, value, kind, repo, ref, path, line_start);
