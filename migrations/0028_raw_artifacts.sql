-- Raw source artifacts, retained so extraction can be re-run without going back
-- to the source.
--
-- The motivating case is PDFs and attachments: extraction is version-dependent,
-- so every future extractor improvement needs the original bytes. Re-fetching a
-- corpus of them from a corporate Confluence behind a proxy is the expensive
-- thing, and for some sources it is not possible at all once the attachment is
-- replaced. Nothing here extracts anything — this slice only makes the bytes
-- durable and re-derivable.
--
-- Two tables, because bytes and observations have different lifetimes. The same
-- PDF attached to three pages is one blob and three observations, and a
-- superseded revision must not delete bytes another revision still references.

-- The bytes. Content-addressed, so the primary key IS the integrity claim.
CREATE TABLE artifacts (
    tenant        text   NOT NULL,
    digest        text   NOT NULL,        -- sha256 of `bytes`, lowercase hex
    size_bytes    bigint NOT NULL,
    bytes         bytea,                  -- NULL only for a non-pg storage kind
    storage       text   NOT NULL DEFAULT 'pg',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant, digest),
    -- A CLOSED discriminant, not an open string. Widening it to 'file' or
    -- 'object' requires a migration, which is the point: a storage kind that
    -- pg_dump does not capture must not become reachable by flipping a config
    -- value or by a future adapter asserting it is safe. Backup completeness is
    -- a property of the schema here, not of an adapter's self-description.
    CONSTRAINT artifacts_storage_kind CHECK (storage IN ('pg')),
    -- Bytes present exactly when they are supposed to be. Proves presence, and
    -- deliberately NOT that the bytes are the ones the digest names — no CHECK
    -- can do that, which is why publication verifies content separately.
    CONSTRAINT artifacts_pg_has_bytes CHECK ((storage = 'pg') = (bytes IS NOT NULL)),
    CONSTRAINT artifacts_size_nonneg CHECK (size_bytes >= 0)
);

-- Where and when those bytes were observed. Immutable: a changed attachment is
-- a new revision, never an edit to an existing row.
CREATE TABLE artifact_versions (
    tenant      text NOT NULL,
    -- The registry spec name, the same join key cursors, coverage families and
    -- reconcile already use. A fourth naming scheme would be a fourth thing to
    -- keep in agreement.
    source      text NOT NULL,
    native_id   text NOT NULL,      -- the source's own id for the attachment
    revision    text NOT NULL,      -- the source's own version token
    digest      text NOT NULL,
    -- Lineage, and the ACL anchor. NOT NULL because an artifact with no
    -- canonical parent has nothing to inherit permissions from: the moment a
    -- citation deep-links to one, "whose document is this?" must have an
    -- answer. An orphan artifact would be a document with no ACL, which is the
    -- one shape the retrieval path must never see.
    doc_id      text NOT NULL,
    -- Belongs to the OBSERVATION, not the blob. The same bytes legitimately
    -- arrive as application/pdf from one source and application/octet-stream
    -- from another; hanging it off the deduplicated row would make idempotent
    -- publication depend on which one happened to land first.
    media_type  text NOT NULL,
    filename    text,
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant, source, native_id, revision),
    -- RESTRICT, not CASCADE or SET NULL. Deleting bytes that an observation
    -- still references is the corruption this table exists to prevent, and
    -- SET NULL would destroy the lineage/ACL anchor precisely when the parent
    -- goes away. Callers delete observations explicitly, in order.
    CONSTRAINT artifact_versions_digest_fk
        FOREIGN KEY (tenant, digest) REFERENCES artifacts (tenant, digest) ON DELETE RESTRICT,
    CONSTRAINT artifact_versions_doc_fk
        FOREIGN KEY (tenant, doc_id) REFERENCES documents (tenant, id) ON DELETE RESTRICT
);

-- Garbage collection scans by digest to find unreferenced blobs.
CREATE INDEX artifact_versions_digest_idx ON artifact_versions (tenant, digest);
-- "What was attached to this document" — the lookup the future extractor and
-- any future citation deep-link both need.
CREATE INDEX artifact_versions_doc_idx ON artifact_versions (tenant, doc_id);
