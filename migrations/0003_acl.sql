-- Ownership for the local-mode ACL rule: personal credentials mean whoever
-- ingested a document could read it at the source, so the ingester always
-- sees their own documents. Everyone else needs a group intersection with
-- acl_groups (stamped by the phase-2 ACL syncer; empty = ingester-only,
-- i.e. fail-closed).
ALTER TABLE documents ADD COLUMN ingested_by text NOT NULL DEFAULT '';
CREATE INDEX documents_ingested_by_idx ON documents (ingested_by);
