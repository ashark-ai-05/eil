-- ASH-71: retain source ACL lineage and make deletion reconciliation recoverable.
ALTER TABLE documents ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN acl_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN acl_version text NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN tombstoned_at timestamptz;
ALTER TABLE documents ADD COLUMN quarantine_until timestamptz;

-- acl_version MUST be byte-identical to what upsertInTx computes, which is
-- sha256(JSON.stringify(aclGroups)). md5(acl_groups::text) matched neither the
-- algorithm (32 hex chars vs 64) nor the serialization (jsonb::text renders
-- ["a", "b"] with a space; JSON.stringify does not). A backfilled value could
-- therefore NEVER equal the computed one, so every pre-existing document failed
-- the hash gate on the next ingest even when nothing had changed — rewriting the
-- whole catalog and, because the chunk re-insert omits the embedding column,
-- silently wiping the entire vector index.
-- string_agg over an empty array yields NULL, hence the coalesce to '[]'.
UPDATE documents
SET acl_snapshot = acl_groups,
    acl_version = encode(sha256(convert_to(coalesce('[' || (
      SELECT string_agg(to_jsonb(e)::text, ',' ORDER BY ord)
        FROM jsonb_array_elements_text(acl_groups) WITH ORDINALITY AS t(e, ord)
    ) || ']', '[]'), 'UTF8')), 'hex')
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
