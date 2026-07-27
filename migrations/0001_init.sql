-- Canonical document catalog. One row per source document; body is markdown,
-- the lingua franca all connectors normalize into.
CREATE TABLE documents (
    id           text PRIMARY KEY,          -- e.g. 'confluence:page:12345', 'jira:issue:PAY-981'
    tenant       text NOT NULL DEFAULT 'default',
    source       text NOT NULL,             -- confluence | jira | bitbucket | transcript | obsidian
    title        text NOT NULL,
    url          text,
    author       text,
    created_at   timestamptz,
    updated_at   timestamptz,
    hierarchy    jsonb NOT NULL DEFAULT '[]',   -- breadcrumb, e.g. ["Space", "Runbooks", "Retries"]
    acl_groups   jsonb NOT NULL DEFAULT '[]',   -- fail-closed: empty means owner-only until ACL sync stamps it
    quality_tier text NOT NULL DEFAULT 'authored',  -- curated | authored | generated | raw
    content_hash text NOT NULL,             -- sha256(body): the idempotency + embed-once gate
    body         text NOT NULL,
    ingested_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_source_idx ON documents (source);
CREATE INDEX documents_updated_idx ON documents (updated_at);

-- Retrieval unit. tsv is the BM25-ish lexical arm (ts_rank for v0; pg_search
-- extension upgrades this to true BM25 later without a schema change).
CREATE TABLE chunks (
    doc_id       text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq          int  NOT NULL,
    heading_path text NOT NULL DEFAULT '',
    text         text NOT NULL,
    content_hash text NOT NULL,
    tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    PRIMARY KEY (doc_id, seq)
);

CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);

-- Link graph. Deliberately no FK on dst_id: edges may point at documents not
-- yet (or never) ingested — a dangling link marks something worth ingesting,
-- not an error.
CREATE TABLE links (
    src_id text NOT NULL,
    dst_id text NOT NULL,
    rel    text NOT NULL DEFAULT 'references',
    PRIMARY KEY (src_id, dst_id, rel)
);

CREATE INDEX links_dst_idx ON links (dst_id);

CREATE TABLE sync_cursors (
    source     text PRIMARY KEY,
    cursor     text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    id           bigserial PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    principal    text NOT NULL,
    tool         text NOT NULL,
    args         jsonb NOT NULL DEFAULT '{}',
    result_count int
);
