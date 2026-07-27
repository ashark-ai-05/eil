# Semantic Search (vector arm) — Design

**Date:** 2026-07-28
**Status:** Building autonomously; user needs semantic search for work-PC Jira usage.
**Context:** Retrieval today is a single lexical arm (`chunks.tsv` FTS). `search.ts:79`
already comments "a kNN arm joins here later and `rrf()` already fuses however many
arms exist," and `search.ts:106` calls `rrf({ fts })` with one arm. This adds the
`vec` arm and fuses it. `@electric-sql/pglite` bundles pgvector, but we deliberately
stay **extension-free** (below) for work-PC portability.

## Problem

Lexical FTS matches keywords/stems, not meaning ("login is broken" won't find
"authentication failure"). The user runs Jira ingestion + search on a locked-down
work PC and needs semantic (meaning-based) retrieval, fused with the existing FTS.

## Decisions

1. **Extension-free vector storage.** Store each chunk's embedding as packed
   `bytea` (float32) on the `chunks` row; compute cosine similarity in-process
   (JS) over the ACL-visible candidate set. Works on **every** Postgres tier
   (PGlite, embedded, system) with **zero install rights** — no `CREATE EXTENSION`
   on the work PC. Brute-force is fine at personal Jira scale (thousands of
   chunks, <100ms); pgvector/HNSW is a documented drop-in acceleration later.
2. **Pluggable embedder** (mirrors the existing `EIL_LLM_PROVIDER` layer in
   `ts/llm/index.ts`): an `Embedder` interface selected by `EIL_EMBED_PROVIDER`.
   v1 ships:
   - `fake` — deterministic hash→unit-vector embedder for tests/CI (no network,
     no model). Same text → same vector; different text → different.
   - `http` — OpenAI-compatible `POST {base}/embeddings {model, input}` for an
     internal LLM gateway (reuses the `EIL_MAAS_*`/`EIL_EMBED_*` config; data
     stays in-org). **Default provider.**
   - A **local ONNX model** provider is a clean future drop-in (no hard native
     dep added until the user opts in).
3. **Reuse `rrf()`** — the vec arm is just another named ranking; fusion,
   rank-modifiers (tier/recency), and ACL are unchanged.
4. **Embed-once**, gated on chunk lifecycle: `upsertDocument` already
   `DELETE`s + re-inserts chunks when a doc changes, so a changed chunk loses its
   embedding and is re-embedded on the next backfill. Backfill embeds only rows
   with `embedding IS NULL` (or a stale `embed_model`).

## Non-Goals (v1)

- pgvector/HNSW indexing (deferred acceleration; storage format allows it later).
- A bundled local embedding model / ONNX runtime (optional future provider).
- Re-ranking, query expansion, hybrid weighting tuning (rrf defaults stand).
- Embedding non-chunk text (titles, etc.) — chunks are the retrieval unit.

## Schema (migration `0007_embeddings.sql`)

```sql
ALTER TABLE chunks ADD COLUMN embedding   bytea;   -- packed float32 LE, NULL until embedded
ALTER TABLE chunks ADD COLUMN embed_model text;    -- provider:model:dim that produced `embedding`
```
No new table, no extension. `embedding` is NULL for un-embedded chunks (the
backfill target). `embed_model` lets a model/dim change invalidate + re-embed.
`chunks` rows are deleted/recreated by `upsertDocument` on doc change, so stale
embeddings can't outlive their text.

## Embedder abstraction (`ts/embed/index.ts`)

```ts
export interface Embedder {
  readonly id: string;           // "provider:model:dim" — stamped into embed_model
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;   // batch; order-preserving
}
export function getEmbedder(name?: string): Embedder;  // EIL_EMBED_PROVIDER > "http"
```
**Injectable everywhere:** the vec arm (`searchDocs`) and the backfill routine
accept an optional `Embedder` (default `getEmbedder()`), so tests pass a
controllable stub returning chosen vectors — no network, no model, and
deterministic cosine relationships. Production paths use the default.
```ts
```
- `FakeEmbedder(dim=64)`: `id="fake:hash:64"`; each text → a deterministic unit
  vector seeded by a hash of the text (stable, distinct). No I/O.
- `HttpEmbedder`: `id="http:<model>:<dim>"`; `POST ${EIL_EMBED_BASE_URL ?? EIL_MAAS_BASE_URL}/embeddings`
  with `{ model: EIL_EMBED_MODEL, input: texts }` and optional
  `Authorization: Bearer ${EIL_EMBED_API_KEY}`; parses `data[].embedding`,
  returns Float32Arrays; `dim` inferred from the first response (validated
  consistent). 30s timeout (reuse the connector `FETCH_TIMEOUT_MS` convention).
- Packing helpers: `packF32(Float32Array): Buffer` / `unpackF32(Buffer): Float32Array`
  (little-endian). `cosine(a: Float32Array, b: Float32Array): number` (pure).

## Backfill command (`eil embed backfill`)

```
eil embed backfill [--batch 64] [--reembed]
```
- Select chunks needing embedding: `embedding IS NULL` (default) OR — with
  `--reembed` — all, and also implicitly any row whose `embed_model` != the
  current embedder `id`.
- Batch the chunk `text`s, call `embedder.embed(batch)`, `UPDATE chunks SET
  embedding=$1, embed_model=$2 WHERE doc_id=$3 AND seq=$4`.
- Report: `embedded N chunks (provider <id>), M already current`. Log batch
  progress. A provider error aborts with a clean message (no partial-silent).

## Vec arm in `search.ts`

Added next to the FTS arm, before fusion:

1. Embed the query once: `const qv = (await embedder.embed([query]))[0]`.
   Guarded — if the provider is unavailable/errors, log and **skip the vec arm**
   (search degrades to FTS-only; never breaks).
2. Candidate fetch (ACL-correct, reuses `visibleSql`):
   ```sql
   SELECT c.doc_id, c.seq, c.text, c.embedding,
          d.title, d.url, d.quality_tier, d.updated_at
   FROM chunks c JOIN documents d ON d.id = c.doc_id
   WHERE c.embedding IS NOT NULL AND <visibleSql>
   ```
   (If zero rows — nothing embedded yet — skip the vec arm; FTS-only.)
3. In JS: `cosine(qv, unpackF32(row.embedding))` per row; sort desc; dedupe to
   best chunk per doc; take top `limit*3` → the `vec` ranked docId list. Merge
   metadata (title/url/tier/updated, snippet = the matched chunk text, trimmed)
   into the shared `byDoc` map for any doc the FTS arm didn't surface.
4. Fuse: `rrf({ fts: [...ftsDocs], vec: [...vecDocs] })` — the only fusion-call
   change. Rank modifiers + ACL + slicing unchanged.

**Scale note (documented, not silent):** the vec arm brute-forces cosine over
all ACL-visible embedded chunks. Fine at personal scale; `log` the candidate
count so growth is visible, and the storage format (`bytea` float32 + a stable
`embed_model`) is pgvector-ready for the HNSW upgrade.

## Wiring / config

- `EIL_EMBED_PROVIDER` = `http` (default) | `fake`. Unknown → clean error.
- `http`: `EIL_EMBED_BASE_URL` (falls back to `EIL_MAAS_BASE_URL`),
  `EIL_EMBED_MODEL`, `EIL_EMBED_API_KEY` (optional).
- Search auto-uses the vec arm **iff** embeddings exist; otherwise pure FTS —
  so nothing changes until the user runs `eil embed backfill`. Fully backward
  compatible.

## Testing

- **Embedder + math (pure, CI):** `FakeEmbedder` determinism (same text→same
  vector, distinct texts differ, unit norm); `packF32`/`unpackF32` round-trip;
  `cosine` correctness (identical=1, orthogonal=0, opposite=-1).
- **Backfill (PGlite, CI):** ingest fixtures → chunks have `embedding IS NULL`;
  `embed backfill` with `EIL_EMBED_PROVIDER=fake` fills them + stamps
  `embed_model`; a second run reports "0 embedded, all current"; `--reembed`
  re-embeds.
- **Vec arm + fusion (PGlite, CI):** using an **injected stub embedder** with
  hand-chosen vectors, a query whose vector is nearest to a chunk that shares NO
  lexical terms with the query is surfaced via the vec arm and appears in fused
  results — proving ranking is cosine-based, not lexical (real semantic *quality*
  needs a real model and is out of CI scope). ACL still filters (an invisible
  embedded chunk never surfaces even if cosine-closest); no-embeddings → FTS-only
  (regression); provider/embed error → FTS-only, no throw.
- **Golden/regression:** existing search tests stay green (FTS path unchanged
  when no embeddings present).

## Files touched

- Create `migrations/0007_embeddings.sql`.
- Create `ts/embed/index.ts` — `Embedder`, `FakeEmbedder`, `HttpEmbedder`,
  `getEmbedder`, `packF32`/`unpackF32`, `cosine`.
- Modify `ts/search.ts` — the vec arm + `rrf({ fts, vec })`, guarded/degrading.
- Modify `ts/cli.ts` — `eil embed backfill`.
- Create `ts/ingest/embed.ts` (or `ts/embed/backfill.ts`) — the backfill routine
  (testable without the CLI).
- Create `ts/tests/embed.test.ts` (pure + PGlite) and extend search tests.
- Modify `README.md` — semantic search section + Status.
