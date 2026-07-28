-- migrations/0008_embedding_float4.sql
-- Move chunks.embedding from packed float32 bytea to float4[], so the semantic
-- arm can be scored INSIDE Postgres and return only the top N rows.
--
-- Before this, every ACL-visible embedded chunk was streamed to Node on every
-- query -- its full text as well as its ~1.5KB vector -- and cosine ran in a
-- loop there. Cost grew linearly with the corpus on every single search, and
-- the chunk text actually dominated the transfer.
--
-- Vectors are stored UNIT-NORMALIZED from here on, which makes cosine identical
-- to a plain dot product -- cheap to express in SQL as a two-array unnest.
-- Normalizing storage cannot change any ranking, because cosine is already
-- scale-invariant.
--
-- Existing embeddings are decoded in place, so no re-embedding is needed.
-- Still no extension: plpgsql and float4[] are core Postgres, so this works on
-- PGlite as well as system PG (pgvector is NOT available on PGlite).

-- Decode little-endian IEEE-754 float32 out of the old bytea layout and return
-- the vector scaled to unit length. Migration-only; dropped at the end.
CREATE FUNCTION eil_f32_to_unit(b bytea) RETURNS float4[] LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  vals float8[] := '{}';
  i int;
  sign int;
  expo int;
  mant int;
  v float8;
  norm float8 := 0;
  out float4[] := '{}';
BEGIN
  FOR i IN 0 .. (octet_length(b) / 4 - 1) LOOP
    sign := get_byte(b, i * 4 + 3) >> 7;
    expo := ((get_byte(b, i * 4 + 3) & 127) << 1) | (get_byte(b, i * 4 + 2) >> 7);
    mant := ((get_byte(b, i * 4 + 2) & 127) << 16) | (get_byte(b, i * 4 + 1) << 8) | get_byte(b, i * 4);
    IF expo = 255 THEN
      v := 0;                                              -- inf/NaN: never valid in an embedding
    ELSIF expo = 0 THEN
      v := (mant / 8388608.0) * pow(2::float8, -126);       -- subnormal
    ELSE
      v := (1 + mant / 8388608.0) * pow(2::float8, expo - 127);
    END IF;
    IF sign = 1 THEN v := -v; END IF;
    vals := vals || v;
    norm := norm + v * v;
  END LOOP;

  norm := sqrt(norm);
  IF norm = 0 THEN norm := 1; END IF;                      -- leave a zero vector as zeros
  FOR i IN 1 .. coalesce(array_length(vals, 1), 0) LOOP
    out := out || (vals[i] / norm)::float4;
  END LOOP;
  RETURN out;
END
$fn$;

ALTER TABLE chunks ADD COLUMN embedding_v float4[];
UPDATE chunks SET embedding_v = eil_f32_to_unit(embedding) WHERE embedding IS NOT NULL;
ALTER TABLE chunks DROP COLUMN embedding;
ALTER TABLE chunks RENAME COLUMN embedding_v TO embedding;

DROP FUNCTION eil_f32_to_unit(bytea);
