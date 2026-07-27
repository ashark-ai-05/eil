-- Link edges are always written alongside their source document, so src_id
-- must reference an ingested doc and should die with it. dst_id stays
-- FK-free on purpose: dangling destinations mark content worth ingesting.
DELETE FROM links l WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = l.src_id);
ALTER TABLE links
    ADD CONSTRAINT links_src_fk FOREIGN KEY (src_id)
    REFERENCES documents (id) ON DELETE CASCADE;
