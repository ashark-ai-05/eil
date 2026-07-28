-- migrations/0007_embeddings.sql
-- Semantic search: extension-free vector storage on chunks. `embedding` is
-- packed float32 (little-endian bytea); cosine runs in-process. No pgvector.
ALTER TABLE chunks ADD COLUMN embedding   bytea;
ALTER TABLE chunks ADD COLUMN embed_model text;
