-- ASH-71: retain source ACL lineage and make deletion reconciliation recoverable.
ALTER TABLE documents ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN acl_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN acl_version text NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN tombstoned_at timestamptz;
ALTER TABLE documents ADD COLUMN quarantine_until timestamptz;

UPDATE documents
SET acl_snapshot = acl_groups,
    acl_version = md5(acl_groups::text)
WHERE acl_version = '';

CREATE TABLE document_revisions (
  tenant text NOT NULL,
  doc_id text NOT NULL,
  revision integer NOT NULL,
  source text NOT NULL,
  content_hash text NOT NULL,
  acl_snapshot jsonb NOT NULL,
  acl_version text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, doc_id, revision),
  FOREIGN KEY (tenant, doc_id) REFERENCES documents (tenant, id) ON DELETE CASCADE
);

INSERT INTO document_revisions
  (tenant, doc_id, revision, source, content_hash, acl_snapshot, acl_version, captured_at)
SELECT tenant, id, revision, source, content_hash, acl_snapshot, acl_version, ingested_at
FROM documents;

CREATE TABLE reconcile_runs (
  id bigserial PRIMARY KEY,
  tenant text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete', 'incomplete')),
  listed_count integer NOT NULL,
  tombstoned_count integer NOT NULL DEFAULT 0,
  actor text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconcile_runs_tenant_source_at_idx ON reconcile_runs (tenant, source, completed_at DESC);
CREATE INDEX documents_active_source_idx ON documents (tenant, source) WHERE tombstoned_at IS NULL;
