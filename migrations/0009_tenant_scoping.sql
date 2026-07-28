-- Shared-serving tenancy hardening. Prior migrations treated tenant as a filter
-- on documents but kept id/source/cursor/audit identities global. Existing rows
-- are preserved as tenant=default; new writes are composite-keyed by tenant.

-- Chunks inherit the tenant of their parent document before the old document FK
-- is replaced with the composite FK.
ALTER TABLE chunks ADD COLUMN tenant text NOT NULL DEFAULT 'default';
UPDATE chunks c SET tenant = d.tenant FROM documents d WHERE d.id = c.doc_id;
ALTER TABLE chunks DROP CONSTRAINT chunks_doc_id_fkey;
ALTER TABLE chunks DROP CONSTRAINT chunks_pkey;
ALTER TABLE chunks ADD PRIMARY KEY (tenant, doc_id, seq);

-- Links are tenant-local. Legacy links inherit the tenant of their source;
-- migration 0004 already removed invalid source links before this composite FK.
ALTER TABLE links ADD COLUMN tenant text NOT NULL DEFAULT 'default';
UPDATE links l SET tenant = d.tenant FROM documents d WHERE d.id = l.src_id;
ALTER TABLE links DROP CONSTRAINT links_src_fk;
ALTER TABLE links DROP CONSTRAINT links_pkey;

-- Canonical IDs are only unique within a tenant.
ALTER TABLE documents DROP CONSTRAINT documents_pkey;
ALTER TABLE documents ADD PRIMARY KEY (tenant, id);
ALTER TABLE chunks
  ADD CONSTRAINT chunks_document_tenant_fk
  FOREIGN KEY (tenant, doc_id) REFERENCES documents (tenant, id) ON DELETE CASCADE;
ALTER TABLE links ADD PRIMARY KEY (tenant, src_id, dst_id, rel);
ALTER TABLE links
  ADD CONSTRAINT links_src_tenant_fk
  FOREIGN KEY (tenant, src_id) REFERENCES documents (tenant, id) ON DELETE CASCADE;

-- Connector cursors are tenant-specific: the same source/scope may legitimately
-- progress independently for different tenants.
ALTER TABLE sync_cursors ADD COLUMN tenant text NOT NULL DEFAULT 'default';
ALTER TABLE sync_cursors DROP CONSTRAINT sync_cursors_pkey;
ALTER TABLE sync_cursors ADD PRIMARY KEY (tenant, source);

-- Audit entries must identify the tenant that authorised the read/action.
ALTER TABLE audit_log ADD COLUMN tenant text NOT NULL DEFAULT 'default';
CREATE INDEX documents_tenant_source_idx ON documents (tenant, source);
CREATE INDEX chunks_tenant_doc_idx ON chunks (tenant, doc_id);
CREATE INDEX links_tenant_dst_idx ON links (tenant, dst_id);
CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant, at);
