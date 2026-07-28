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
CREATE INDEX code_index_lookup_idx ON code_index (tenant, repo, ref, kind, value, path, line_start);
