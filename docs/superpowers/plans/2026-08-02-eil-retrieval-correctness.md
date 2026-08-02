# EIL Retrieval Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the semantic arm read the whole chunk, make snippets sufficient enough that agents stop fetching whole documents, and replace weighted RRF with normalised convex combination.

**Architecture:** Three independent changes to the deterministic query path. (1) Embeddings move from one-vector-per-chunk to one-vector-per-embedder-window in a new `chunk_vectors` table, because `MAX_CHARS = 3200` is three times the MiniLM window of 1024 and everything past the first window is currently embedded into nothing. (2) Snippets grow from human-scanning size to agent-sufficiency size and carry an explicit `truncated` flag so an agent can tell silence from completeness. (3) `rrf()` is replaced by `combine()`, a weighted sum of per-arm min-max-normalised scores, because rank fusion discards the score distribution that tells a 0.95 semantic match from a 0.35 one.

**Tech Stack:** TypeScript (ESM, `tsx`), Vitest, Postgres/PGlite with raw SQL, `float4[]` embeddings, vendored Xenova/all-MiniLM-L6-v2 via `@huggingface/transformers`.

## Global Constraints

- Node ESM throughout; all local imports carry the `.js` extension even from `.ts` sources.
- `tsc --noEmit` must pass; the repo runs `exactOptionalPropertyTypes`, so genuinely-absent optional properties are typed `?: T | undefined`.
- `pnpm lint` (Biome) must pass; run `pnpm lint:fix` before committing.
- Migrations are append-only, numbered `NNNN_name.sql`, and **must never perform an unbounded UPDATE** — backfills live in application code and must be resumable.
- Every SQL read of `documents` goes through `visibleSql()`; the ACL predicate is never caller-controlled.
- `tests/golden/confluence_page.chunks.json` is a byte-exact contract for `chunk()`. **No task in this plan may change `ts/core/chunker.ts`.**
- Tenant is part of chunk identity: `(tenant, doc_id, seq)`. Never write a chunk-keyed row without binding tenant.
- Test command is `pnpm test` (Vitest); a single file is `pnpm test <path>`.

---

### Task 1: `embedWindows()` — split a chunk into embedder-sized windows

Pure function, no I/O, no schema. Establishes the windowing contract that Tasks 2 and 3 depend on.

**Files:**
- Create: `ts/embed/window.ts`
- Create: `ts/tests/window.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `embedWindows(headingPath: string, text: string, windowChars: number): string[]` and `export const WINDOW_OVERLAP = 0.25`. Task 2 calls `embedWindows` from `ts/embed/backfill.ts`.

- [ ] **Step 1: Write the failing test**

Create `ts/tests/window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WINDOW_OVERLAP, embedWindows } from "../embed/window.js";

const CAP = 100;

describe("embedWindows", () => {
  it("returns a single prefixed window when the text fits", () => {
    const out = embedWindows("Page > Section", "short body", CAP);
    expect(out).toEqual(["Page > Section\n\nshort body"]);
  });

  it("returns the bare text when there is no heading", () => {
    expect(embedWindows("", "short body", CAP)).toEqual(["short body"]);
  });

  it("never exceeds the window", () => {
    const out = embedWindows("H", "x".repeat(1000), CAP);
    expect(out.length).toBeGreaterThan(1);
    for (const w of out) expect(w.length).toBeLessThanOrEqual(CAP);
  });

  it("repeats the heading on every window", () => {
    const out = embedWindows("Breadcrumb", "y".repeat(1000), CAP);
    for (const w of out) expect(w.startsWith("Breadcrumb\n\n")).toBe(true);
  });

  it("overlaps consecutive windows", () => {
    const text = Array.from({ length: 400 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const out = embedWindows("", text, CAP);
    const first = out[0]!;
    const second = out[1]!;
    const budget = CAP;
    const step = Math.floor(budget * (1 - WINDOW_OVERLAP));
    expect(second).toBe(text.slice(step, step + budget));
    expect(step).toBeLessThan(budget); // i.e. they genuinely overlap
  });

  it("covers the whole text — the tail is never dropped", () => {
    const text = "z".repeat(517) + "TAIL";
    const out = embedWindows("", text, CAP);
    expect(out[out.length - 1]!.endsWith("TAIL")).toBe(true);
  });

  it("keeps one window when the embedder has no finite window", () => {
    const out = embedWindows("H", "q".repeat(50_000), Number.MAX_SAFE_INTEGER);
    expect(out).toHaveLength(1);
  });

  it("truncates a heading that would eat more than half the window", () => {
    const out = embedWindows("H".repeat(200), "body text here", CAP);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeLessThanOrEqual(CAP);
    expect(out[0]!.endsWith("body text here")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test ts/tests/window.test.ts`
Expected: FAIL — `Failed to resolve import "../embed/window.js"`.

- [ ] **Step 3: Write the implementation**

Create `ts/embed/window.ts`:

```ts
/**
 * Split a chunk into embedder-sized windows.
 *
 * chunker.MAX_CHARS is 3200; the vendored MiniLM-L6 reads 1024 (256 tokens at
 * ~4 chars/token). One vector per chunk therefore embedded the first third and
 * silently ignored the rest — measured, two 3200-char texts differing only past
 * ~1600 chars produce cosine 1.000000. quality.ts has been counting the affected
 * chunks as `chunks_over_embed_window` without anything acting on it.
 *
 * The heading breadcrumb is repeated on EVERY window rather than only the first.
 * It is what makes a window interpretable in isolation, which is exactly why
 * backfill prepends it today, and dropping it after window 0 would make the tail
 * windows worse than the head one for no saving.
 *
 * Windows overlap so a sentence spanning a boundary still appears whole in one
 * of them. TREC's Podcasts track used 50% overlap on ~340-word segments; 25% is
 * the cheaper end of that range and keeps the vector count at ~4 per max chunk.
 */

export const WINDOW_OVERLAP = 0.25;

export function embedWindows(headingPath: string, text: string, windowChars: number): string[] {
  const join = (t: string) => (headingPath ? `${headingPath}\n\n${t}` : t);
  // A non-finite window is the hash/HTTP embedder saying "I read everything".
  // Windowing it would multiply cost for no gain.
  if (!Number.isFinite(windowChars) || windowChars <= 0) return [join(text)];

  const cap = Math.floor(windowChars);
  // The breadcrumb may not eat the window. Past half, a window carries more
  // context than content and every window in the chunk embeds to nearly the
  // same vector — the exact failure this function exists to remove.
  const half = Math.max(1, Math.floor(cap / 2));
  let prefix = headingPath ? `${headingPath}\n\n` : "";
  if (prefix.length > half) prefix = `${headingPath.slice(0, Math.max(1, half - 2))}\n\n`;

  const budget = cap - prefix.length;
  if (budget <= 0) return [prefix];
  if (text.length <= budget) return [prefix + text];

  const step = Math.max(1, Math.floor(budget * (1 - WINDOW_OVERLAP)));
  const out: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    out.push(prefix + text.slice(start, start + budget));
    if (start + budget >= text.length) break;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test ts/tests/window.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add ts/embed/window.ts ts/tests/window.test.ts
git commit -m "feat: split chunks into embedder-sized windows

MAX_CHARS is 3200 and MiniLM reads 1024, so two thirds of every long
chunk was embedded into nothing. embedWindows() is the unit the vector
arm should have been using all along."
```

---

### Task 2: `chunk_vectors` — one vector per window, end to end

Moves the vector arm off `chunks.embedding` and onto a window-grained table. The IVF funnel degrades to an exact scan for the duration of this task, which the existing `vecArm` SQL already handles (`$7::int[] IS NULL` → scan everything). Task 3 restores it.

**Files:**
- Create: `migrations/0020_chunk_vectors.sql`
- Modify: `ts/embed/backfill.ts` (whole `backfill` body)
- Modify: `ts/search.ts:518-630` (`vecArm`)
- Modify: `ts/quality.ts:65-80` (the over-window counter it obsoletes)
- Test: `ts/tests/window-vectors.test.ts`

**Interfaces:**
- Consumes: `embedWindows(headingPath, text, windowChars)` from Task 1; `Embedder.windowChars` from `ts/embed/index.ts`.
- Produces: table `chunk_vectors (tenant, doc_id, seq, ord, embedding, embed_model, sig, cluster_id)` with PK `(tenant, doc_id, seq, ord)`. Task 3 reads and updates `sig` / `cluster_id` on this table.

- [ ] **Step 1: Write the migration**

Create `migrations/0020_chunk_vectors.sql`:

```sql
-- migrations/0020_chunk_vectors.sql
-- One vector per EMBEDDER WINDOW, not one per chunk.
--
-- chunker.MAX_CHARS is 3200; the vendored MiniLM reads 1024. Everything past the
-- first window was embedded into nothing, silently: two 3200-char texts
-- differing only past ~1600 chars score cosine 1.000000 against each other.
-- quality.ts has counted the affected rows as chunks_over_embed_window since it
-- was written; nothing acted on the number.
--
-- chunks.embedding / .embed_model / .sig / .cluster_id are deliberately LEFT IN
-- PLACE. Dropping them would make a rollback require a full re-embed, and this
-- migration is meant to be reversible by pointing the read path back.
--
-- No backfill here: `eil embed backfill --reembed` fills this table, resumably.
-- A migration that UPDATEs the whole corpus is an outage, not a schema change.

CREATE TABLE chunk_vectors (
    tenant      text NOT NULL,
    doc_id      text NOT NULL,
    seq         int  NOT NULL,
    ord         int  NOT NULL,
    embedding   float4[] NOT NULL,
    embed_model text NOT NULL,
    sig         varbit,
    cluster_id  int,
    PRIMARY KEY (tenant, doc_id, seq, ord),
    FOREIGN KEY (tenant, doc_id, seq)
        REFERENCES chunks (tenant, doc_id, seq) ON DELETE CASCADE
);

-- Cluster probing filters on (tenant, cluster_id) exactly as chunks_ivf_idx did.
CREATE INDEX chunk_vectors_ivf_idx ON chunk_vectors (tenant, cluster_id);
-- The "is anything embedded with this model?" probe in vecArm.
CREATE INDEX chunk_vectors_model_idx ON chunk_vectors (tenant, embed_model);
```

- [ ] **Step 2: Write the failing test**

Create `ts/tests/window-vectors.test.ts`. This mirrors the setup style of `ts/tests/embed.test.ts` — read that file first for how it builds a PGlite database and a deterministic embedder.

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import { narrowEmbedder, openTestDb, seedDoc } from "./helpers/db.js";

const narrow = narrowEmbedder;

describe("window-grained embeddings", () => {
  let db: Awaited<ReturnType<typeof openTestDb>>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  it("writes more than one vector for a chunk longer than the window", async () => {
    await seedDoc(db, { id: "conf:1", text: "a".repeat(600), headingPath: "Page" });
    await backfill(db, narrow, { reembed: true });
    const n = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE doc_id = $1 AND seq = 0",
      ["conf:1"],
    );
    expect(n.rows[0].n).toBeGreaterThan(1);
  });

  it("numbers windows from zero, contiguously", async () => {
    await seedDoc(db, { id: "conf:1", text: "b".repeat(600), headingPath: "Page" });
    await backfill(db, narrow, { reembed: true });
    const r = await db.query(
      "SELECT ord FROM chunk_vectors WHERE doc_id = $1 AND seq = 0 ORDER BY ord",
      ["conf:1"],
    );
    expect(r.rows.map((x: any) => Number(x.ord))).toEqual(
      r.rows.map((_: unknown, i: number) => i),
    );
  });

  it("distinguishes texts that differ only in their tail", async () => {
    await seedDoc(db, { id: "conf:head", text: `${"c".repeat(500)}ALPHA`, headingPath: "P" });
    await seedDoc(db, { id: "conf:tail", text: `${"c".repeat(500)}OMEGA`, headingPath: "P" });
    await backfill(db, narrow, { reembed: true });
    const r = await db.query(
      "SELECT doc_id, ord, embedding FROM chunk_vectors ORDER BY doc_id, ord",
    );
    const last = (doc: string) => {
      const rows = r.rows.filter((x: any) => x.doc_id === doc);
      return rows[rows.length - 1]!.embedding.map(Number);
    };
    const a = last("conf:head");
    const b = last("conf:tail");
    const cos = a.reduce((s: number, x: number, i: number) => s + x * b[i]!, 0);
    // The whole point: the differing tails must NOT embed to the same vector.
    expect(cos).toBeLessThan(0.999999);
  });

  it("replaces rather than accumulates on re-embed", async () => {
    await seedDoc(db, { id: "conf:1", text: "d".repeat(600), headingPath: "Page" });
    await backfill(db, narrow, { reembed: true });
    const first = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    await backfill(db, narrow, { reembed: true });
    const second = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
    expect(second.rows[0].n).toBe(first.rows[0].n);
  });
});
```

Add these three exports to `ts/tests/helpers/db.ts`, creating the file if absent, following the PGlite setup in `ts/tests/pglite.test.ts`:

```ts
import type { Embedder } from "../../embed/index.js";

/** Deterministic 8-dim embedder with a 100-char window, so windowing is forced
 *  in tests without loading the real 384-dim model. */
export const narrowEmbedder: Embedder = {
  id: "test:narrow",
  windowChars: 100,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 8]! += t.charCodeAt(i) / 1000;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};
```

`openTestDb()` must return a migrated PGlite `Db` (apply every file in `migrations/` in filename order). `seedDoc(db, { id, text, headingPath })` must insert one `documents` row — tenant `default`, `ingested_by` equal to the principal `testViewer()` uses, `quality_tier` `authored`, `source` `confluence` — and one `chunks` row at `seq = 0` carrying `heading_path` and `text`. `testViewer()` must build its `Viewer` through `viewerFromAuthenticatedClaims({ principal, tenant: "default", groups: [] })` so it passes the trusted-viewer check.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test ts/tests/window-vectors.test.ts`
Expected: FAIL — `relation "chunk_vectors" does not exist`.

- [ ] **Step 4: Rewrite `backfill` to write windows**

Replace the whole body of `backfill` in `ts/embed/backfill.ts`:

```ts
/** Embed chunks for the semantic arm, one vector per EMBEDDER WINDOW.
 *  Embed-once: only chunks with no current-model vectors unless --reembed.
 *  Provider errors abort (no partial-silent). */
import type { Db } from "../db.js";
import { type Embedder, toVec } from "./index.js";
import { embedWindows } from "./window.js";

export async function backfill(
  client: Db,
  embedder: Embedder,
  opts: { batch?: number; reembed?: boolean },
): Promise<{ embedded: number }> {
  const batch = opts.batch ?? 64;
  // tenant is part of the chunk identity since migration 0009 — (doc_id, seq) is
  // NO LONGER unique. Selecting and binding it is not cosmetic: the tenant-blind
  // write put one tenant's vector on every same-id chunk in every other tenant,
  // so a query phrased against tenant B's wording could surface tenant A's
  // document. Cross-tenant inference through the ranking channel.
  const rows = (
    await client.query(
      opts.reembed
        ? "SELECT tenant, doc_id, seq, heading_path, text FROM chunks ORDER BY tenant, doc_id, seq"
        : "SELECT c.tenant, c.doc_id, c.seq, c.heading_path, c.text FROM chunks c" +
            " WHERE NOT EXISTS (SELECT 1 FROM chunk_vectors v" +
            "   WHERE v.tenant = c.tenant AND v.doc_id = c.doc_id AND v.seq = c.seq" +
            "     AND v.embed_model = $1)" +
            " ORDER BY c.tenant, c.doc_id, c.seq",
      opts.reembed ? [] : [embedder.id],
    )
  ).rows as Array<{
    tenant: string;
    doc_id: string;
    seq: number;
    heading_path: string;
    text: string;
  }>;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    // The breadcrumb is composed back on for the EMBEDDING only, and onto every
    // window — it is real context for a vector, and it is why a window is
    // interpretable in isolation. It does not belong in stored text, where it
    // would be charged to every snippet.
    const perChunk = slice.map((r) => embedWindows(r.heading_path, r.text, embedder.windowChars));
    const flat = perChunk.flat();
    const vecs = await embedder.embed(flat);

    let k = 0;
    for (let j = 0; j < slice.length; j++) {
      const row = slice[j]!;
      const windows = perChunk[j]!;
      // Replace, never accumulate: a chunk that got shorter must not keep the
      // vectors of windows that no longer exist, or the vector arm would score
      // text the document no longer contains.
      await client.query(
        "DELETE FROM chunk_vectors WHERE tenant = $1 AND doc_id = $2 AND seq = $3 AND embed_model = $4",
        [row.tenant, row.doc_id, row.seq, embedder.id],
      );
      for (let ord = 0; ord < windows.length; ord++) {
        await client.query(
          "INSERT INTO chunk_vectors (tenant, doc_id, seq, ord, embedding, embed_model)" +
            " VALUES ($1, $2, $3, $4, $5, $6)",
          [row.tenant, row.doc_id, row.seq, ord, toVec(vecs[k]!), embedder.id],
        );
        k += 1;
      }
      embedded += 1;
    }
    console.log(`  embedded ${Math.min(i + batch, rows.length)}/${rows.length} chunks`);
  }
  return { embedded };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test ts/tests/window-vectors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit the write path**

```bash
git add migrations/0020_chunk_vectors.sql ts/embed/backfill.ts ts/tests/window-vectors.test.ts ts/tests/helpers/db.ts
git commit -m "feat: embed one vector per window into chunk_vectors

The tail of every chunk over 1024 chars was previously embedded into
nothing. Read path still points at chunks.embedding; next commit moves it."
```

- [ ] **Step 7: Point `vecArm` at `chunk_vectors`**

In `ts/search.ts`, in `vecArm`, replace the existence probe:

```ts
  const has = await client.query(
    "SELECT 1 FROM chunk_vectors WHERE tenant = $2 AND embed_model = $1 LIMIT 1",
    [emb.id, viewer.tenant],
  );
  if (has.rows.length === 0) return null; // nothing embedded with this model -> pure FTS
```

and replace the `cand` and `scored` CTEs of the main query (leave `best`, `top`, the final SELECT, and the whole parameter array unchanged):

```sql
    `WITH cand AS (
       SELECT v.doc_id, v.seq, v.ord, v.embedding
         FROM chunk_vectors v JOIN documents d ON d.tenant = v.tenant AND d.id = v.doc_id
        WHERE v.embed_model = $5 AND ${visibleSql(1, 2, 3)}
          AND ($7::int[] IS NULL OR v.cluster_id = ANY($7::int[]))
          AND ($11::text[] IS NULL OR d.source = ANY($11::text[]))
        ORDER BY CASE WHEN $8::varbit IS NULL OR v.sig IS NULL THEN 0
                      ELSE bit_count(v.sig # $8::varbit) END,
                 v.doc_id, v.seq, v.ord
        LIMIT CASE WHEN $7::int[] IS NULL THEN $9::bigint ELSE $10::bigint END
     ), scored AS (
       SELECT c.doc_id, c.seq,
              (SELECT sum(a::float8 * b::float8)
                 FROM unnest(c.embedding, $4::float4[]) AS t(a, b)) AS score
         FROM cand c
     ), best AS (
```

`best` already does `DISTINCT ON (doc_id) ... ORDER BY doc_id, score DESC, seq`, which now means *best window of the best chunk per document* — exactly the intended semantics. The `top` join back to `chunks ch ON ... ch.seq = t.seq` still resolves, because `seq` survives the window split.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS. `ts/tests/embed.test.ts` and `ts/tests/pglite.test.ts` exercise the vector arm; if either asserts on `chunks.embedding` directly, update that assertion to read `chunk_vectors` — do not weaken the assertion.

- [ ] **Step 9: Retire the over-window counter**

The `chunks_over_embed_window` count in `ts/quality.ts:65-80` measured the bug this task fixes. It now measures nothing, but silently deleting a health signal is worse than repurposing it. Replace the block with a count of chunks that have **no** vector under the current model:

```ts
  // Chunks used to be embedded whole and silently truncated at the embedder's
  // window; migration 0020 splits them, so the old over-window count is
  // structurally zero. What can still go wrong is a chunk with NO vector at all —
  // an aborted or never-run backfill — which is invisible from the outside
  // because the vector arm just quietly returns fewer candidates.
  const { getEmbedder } = await import("./embed/index.js");
  let unembedded = 0;
  try {
    const model = getEmbedder().id;
    unembedded = await one(
      "SELECT count(*)::int AS n FROM chunks c WHERE NOT EXISTS (" +
        " SELECT 1 FROM chunk_vectors v WHERE v.tenant = c.tenant" +
        " AND v.doc_id = c.doc_id AND v.seq = c.seq AND v.embed_model = $1)",
      [model],
    );
  } catch {
    /* embedder unavailable: not an integrity fault */
  }
```

Then rename the reported field from `chunks_over_embed_window` to `chunks_unembedded` in the returned object at `ts/quality.ts:89+`, and update any consumer — grep first:

Run: `grep -rn "chunks_over_embed_window" ts/ observability/ docs/`

Update every hit, including `observability/grafana/dashboards/eil-overview.json` if it appears there.

- [ ] **Step 10: Run the full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 11: Commit**

```bash
git add ts/search.ts ts/quality.ts ts/tests observability
git commit -m "feat: read the semantic arm from window-grained vectors

Best window of the best chunk per document, so a match in the tail of a
long page can finally win. quality now reports unembedded chunks, which
is the failure that remains possible."
```

---

### Task 3: restore the IVF funnel on `chunk_vectors`

After Task 2 every `sig` and `cluster_id` is NULL, so `vecArm` falls back to an exact scan — correct but slow. This is a mechanical re-pointing of the coarse index onto the new key.

**Files:**
- Modify: `ts/embed/buildivf.ts:27-51` (`backfillSignatures`), `:55-72` (`sampleVectors`), `:106-112` (the `n_assigned` update), `:118-148` (`assignClusters`), `:181-186` (the calibration corpus read)
- Test: `ts/tests/ivf-windows.test.ts`

**Interfaces:**
- Consumes: `chunk_vectors` from Task 2.
- Produces: no new exports — the existing signatures of `backfillSignatures`, `buildCentroids`, `assignClusters`, `calibrate`, and `chosenNprobe` are unchanged.

**Carried finding from Task 2's review (must be addressed here).** `vecArm`'s candidate budget is now denominated in WINDOWS, not chunks. `ts/search.ts:586` still reads `LIMIT CASE WHEN $7::int[] IS NULL THEN $9::bigint ELSE $10::bigint END` with `$10 = limit * OVERSAMPLE`, but at ~4 windows per 3200-char chunk that survivor set now covers roughly a quarter as many distinct documents as it did when one row meant one chunk. This is harmless today only because `$7` is always NULL and the funnel runs as a full exact scan — the moment this task restores cluster probing, `$10` becomes live and recall silently drops. Two consequences to handle:

- Re-examine `OVERSAMPLE` in `ts/embed/ivf.ts` against the new row grain. The calibration in `calibrate()` measures recall@10 empirically and picks the smallest `nprobe` clearing `RECALL_GATE`, so the gate itself will catch a bad choice — but only if you re-run it. Step 9 below is therefore not optional.
- The performance comment at `ts/search.ts:568-572` quotes "1.30 us/chunk" and "0.17 us/chunk". Those figures are now per WINDOW. Update the units in that comment; do not invent new numbers, just say which unit they are in and that the row count per chunk is now ~4x.

**Also fix here (deferred from Task 2's review):** `ts/cli.ts:505-509` (`eil ivf status`) counts `chunks WHERE embedding IS NOT NULL` and will report `embedded 0` on a working corpus. Repoint it at `chunk_vectors`.

- [ ] **Step 1: Write the failing test**

Create `ts/tests/ivf-windows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backfill } from "../embed/backfill.js";
import { assignClusters, backfillSignatures, buildCentroids } from "../embed/buildivf.js";
import { loadCentroids } from "../embed/ivf.js";
import { narrowEmbedder, openTestDb, seedDoc } from "./helpers/db.js";

describe("ivf over window vectors", () => {
  it("signs every window, not just the first per chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, { id: "conf:1", text: "a".repeat(600), headingPath: "Page" });
    await backfill(db, narrowEmbedder, { reembed: true });
    await backfillSignatures(db, narrowEmbedder.id);
    const r = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE sig IS NULL",
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("assigns a cluster to every window", async () => {
    const db = await openTestDb();
    for (let i = 0; i < 8; i++) {
      await seedDoc(db, { id: `conf:${i}`, text: `${i}`.repeat(600), headingPath: "Page" });
    }
    await backfill(db, narrowEmbedder, { reembed: true });
    await backfillSignatures(db, narrowEmbedder.id);
    await buildCentroids(db, narrowEmbedder.id, { nlist: 2 });
    const centroids = await loadCentroids(db, narrowEmbedder.id);
    await assignClusters(db, narrowEmbedder.id, centroids);
    const r = await db.query(
      "SELECT count(*)::int AS n FROM chunk_vectors WHERE cluster_id IS NULL",
    );
    expect(r.rows[0].n).toBe(0);
  });
});
```

`narrowEmbedder`, `openTestDb` and `seedDoc` all come from `ts/tests/helpers/db.ts`, added in Task 2 Step 2 — no new helpers are needed here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test ts/tests/ivf-windows.test.ts`
Expected: FAIL — the first test reports a non-zero count, because `backfillSignatures` still updates `chunks`.

- [ ] **Step 3: Re-point `backfillSignatures`**

In `ts/embed/buildivf.ts`, replace the two queries inside `backfillSignatures`:

```ts
    const rows = await client.query(
      "SELECT tenant, doc_id, seq, ord, embedding FROM chunk_vectors" +
        " WHERE embed_model = $1 AND sig IS NULL" +
        " ORDER BY tenant, doc_id, seq, ord LIMIT $2",
      [embedModel, batch],
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      await client.query(
        "UPDATE chunk_vectors SET sig = $1::varbit" +
          " WHERE tenant = $2 AND doc_id = $3 AND seq = $4 AND ord = $5",
        [signature((r.embedding as number[]).map(Number)), r.tenant, r.doc_id, r.seq, r.ord],
      );
      written += 1;
    }
```

- [ ] **Step 4: Re-point `sampleVectors`**

```ts
async function sampleVectors(
  client: Db,
  embedModel: string,
  limit: number,
): Promise<Array<{ tenant: string; docId: string; seq: number; ord: number; vec: Float32Array }>> {
  const res = await client.query(
    "SELECT tenant, doc_id, seq, ord, embedding FROM chunk_vectors" +
      " WHERE embed_model = $1" +
      " ORDER BY tenant, doc_id, seq, ord LIMIT $2",
    [embedModel, limit],
  );
  return res.rows.map((r: any) => ({
    tenant: r.tenant,
    docId: r.doc_id,
    seq: Number(r.seq),
    ord: Number(r.ord),
    vec: Float32Array.from((r.embedding as number[]).map(Number)),
  }));
}
```

- [ ] **Step 5: Re-point `assignClusters`**

The keyset pagination cursor gains `ord`:

```ts
export async function assignClusters(
  client: Db,
  embedModel: string,
  centroids: Centroid[],
  batch = 2_000,
): Promise<number> {
  let done = 0;
  let after: { tenant: string; docId: string; seq: number; ord: number } | null = null;
  for (;;) {
    const rows = await client.query(
      "SELECT tenant, doc_id, seq, ord, embedding FROM chunk_vectors" +
        " WHERE embed_model = $1" +
        "   AND ($2::text IS NULL OR (tenant, doc_id, seq, ord) > ($2, $3, $4, $5))" +
        " ORDER BY tenant, doc_id, seq, ord LIMIT $6",
      [
        embedModel,
        after?.tenant ?? null,
        after?.docId ?? null,
        after?.seq ?? null,
        after?.ord ?? null,
        batch,
      ],
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const [best] = probeClusters((r.embedding as number[]).map(Number), centroids, 1);
      await client.query(
        "UPDATE chunk_vectors SET cluster_id = $1" +
          " WHERE tenant = $2 AND doc_id = $3 AND seq = $4 AND ord = $5",
        [best ?? 0, r.tenant, r.doc_id, r.seq, r.ord],
      );
      done += 1;
    }
    const last = rows.rows[rows.rows.length - 1];
    after = {
      tenant: last.tenant,
      docId: last.doc_id,
      seq: Number(last.seq),
      ord: Number(last.ord),
    };
    console.log(`  assigned: ${done}`);
  }
  return done;
}
```

- [ ] **Step 6: Re-point the `n_assigned` rollup and the calibration corpus**

In `buildCentroids`, the count becomes:

```ts
    await client.query(
      "UPDATE ivf_centroids SET n_assigned = (SELECT count(*) FROM chunk_vectors WHERE embed_model = $1 AND cluster_id = $2)" +
        " WHERE embed_model = $1 AND cluster_id = $2",
      [embedModel, c.clusterId],
    );
```

In `calibrate`, the corpus read and its key:

```ts
  const all = await client.query(
    "SELECT tenant, doc_id, seq, ord, cluster_id, sig, embedding FROM chunk_vectors" +
      " WHERE sig IS NOT NULL AND embed_model = $1" +
      " ORDER BY tenant, doc_id, seq, ord",
    [embedModel],
  );
  const corpus = all.rows.map((r: any) => ({
    key: `${r.tenant} ${r.doc_id} ${r.seq} ${r.ord}`,
    cluster: Number(r.cluster_id),
    sig: String(r.sig),
    vec: (r.embedding as number[]).map(Number),
  }));
```

The query top-up further down still reads `text FROM chunks` — leave it. Text lives on `chunks`, and a chunk's own text remains a legitimate geometry probe. Remove only the now-meaningless `embedding IS NOT NULL` predicate from that top-up query, replacing it with a join:

```ts
    const sampled = await client.query(
      "SELECT c.text FROM chunks c" +
        " WHERE EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.tenant = c.tenant" +
        "   AND v.doc_id = c.doc_id AND v.seq = c.seq AND v.embed_model = $1)" +
        " ORDER BY c.tenant, c.doc_id, c.seq",
      [embedModel],
    );
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test ts/tests/ivf-windows.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Repair the three sanctioned failures and the stale CLI counter**

Task 2 deliberately left three tests failing, because it moved the vectors and this task moves the index that reads them. They are:

```
ts/tests/ivf.test.ts > the funnel against a real database > signs every embedded chunk and is resumable
ts/tests/ivf.test.ts > the funnel against a real database > clusters every embedded chunk and records the assignment counts
ts/tests/ivf.test.ts > the funnel against a real database > calibrates, persists the whole curve, and picks the smallest passing nprobe
```

All three call `backfillSignatures` / `buildCentroids` / `calibrate` and then assert against `chunks`. Repoint each assertion at `chunk_vectors`, keyed by `(tenant, doc_id, seq, ord)`. **Move the assertions; do not weaken or delete them** — the two tests in that file that already pass (`returns the SAME results as the exact scan once calibrated`, `degrades to the exact scan when the index is absent`) are the ones proving the funnel is still equivalent to brute force, and they must keep passing untouched.

Then repoint `ts/cli.ts:505-509` (`eil ivf status`), which counts `chunks WHERE embedding IS NOT NULL` and would report `embedded 0` on a fully embedded corpus.

- [ ] **Step 9: Recalibrate and confirm the recall gate still clears**

Restoring cluster probing makes `$10 = limit * OVERSAMPLE` live for the first time since the row grain changed from chunks to windows. `calibrate()` measures recall@10 against a full exact scan and only adopts an `nprobe` that clears `RECALL_GATE`, so it is the check that catches a now-undersized oversample. Run it against the test corpus the `ivf.test.ts` calibration test builds, and report in your task report: the chosen `nprobe`, the chosen `oversample`, and the recall@10 at each point on the curve.

If no `nprobe` below `nlist` clears the gate, that is a real finding, not a test to adjust — say so in the report rather than lowering the gate or hand-picking a value. The correct response is a larger `OVERSAMPLE`, and the calibration output is the evidence for choosing it.

- [ ] **Step 10: Run the full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: the suite fully green — including the three tests Task 2 left failing. Lint will still show three pre-existing errors in `ts/cli.ts` and `ts/db.ts` that predate this work; if your `ivf status` edit lets you clear the `cli.ts` ones for free, do it, otherwise leave them.

- [ ] **Step 11: Commit**

```bash
git add ts/embed/buildivf.ts ts/embed/ivf.ts ts/cli.ts ts/search.ts ts/tests
git commit -m "feat: build the coarse index over window vectors

Signatures and clusters follow the vectors onto chunk_vectors; the key
gains ord. The candidate budget is now denominated in windows rather than
chunks, so recalibration is required, not optional:
eil ivf build && eil ivf calibrate."
```

- [ ] **Step 12: Record the operator step**

Add to `README.md`, under whichever section documents `eil embed backfill` (grep for `ivf calibrate` to find it), the sentence:

```markdown
Migration 0020 moves embeddings to one vector per embedder window. After
applying it, run `eil embed backfill --reembed`, then `eil ivf build` and
`eil ivf calibrate` — the previous calibration was measured against a
different number of vectors and no longer describes this index.
```

Commit:

```bash
git add README.md
git commit -m "docs: note the re-embed and recalibration 0020 requires"
```

---

### Task 4: snippets sized for an agent, not a reader

`SNIPPET_OPTS` is `MaxWords=40, MinWords=10` — roughly 200 characters, tuned for a human scanning a results page. Every `get_doc` an agent makes because a snippet was too short is a cost event. Provence (ICLR 2025) measured query-biased extraction holding answer quality at 50–80% compression, with ~6 sentences the sweet spot; "Searching for Best Practices in RAG" found best F1 at ~60 tokens of query-biased extract.

**Files:**
- Modify: `ts/search.ts:17` (`SNIPPET_OPTS`), `:116-123` (`SearchResult`), `:217-278` (the lexical query and result assembly), `:617-628` (the vector-arm snippet)
- Create: `migrations/0022_fetch_through.sql`
- Test: `ts/tests/snippet.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SearchResult` gains `truncated: boolean`. Task 5 does not read it, but `ts/mcp-server.ts` surfaces it to the agent.

- [ ] **Step 1: Write the failing test**

Create `ts/tests/snippet.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { searchDocs } from "../search.js";
import { openTestDb, seedDoc, testViewer } from "./helpers/db.js";

describe("snippets", () => {
  // NOTE: an earlier draft of this plan opened with
  // `expect(SNIPPET_OPTS).toContain("MaxWords=90")`. That asserts a constant's
  // spelling rather than any behaviour — it cannot fail for any reason that
  // matters and it pins the implementation instead of the contract. Deleted
  // deliberately; the two tests below cover the behaviour that the wider
  // snippet is FOR. Do not reinstate it.

  it("returns an extract long enough to answer from", async () => {
    const db = await openTestDb();
    await seedDoc(db, {
      id: "conf:long",
      text: "The retry policy uses exponential backoff. ".repeat(80),
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff policy", 5);
    // The old MaxWords=40 produced ~200 characters, below the point where an
    // extract can answer anything, so the agent fetched the whole document.
    expect(out.results[0].snippet.replaceAll("**", "").length).toBeGreaterThan(300);
  });

  it("marks a snippet that does not cover the whole chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, {
      id: "conf:long",
      text: `${"The retry policy uses exponential backoff. ".repeat(80)}`,
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff policy", 5);
    expect(out.results[0].truncated).toBe(true);
  });

  it("does not mark a snippet that covers its whole chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, { id: "conf:short", text: "Retry uses backoff.", headingPath: "Retry" });
    const out: any = await searchDocs(db, testViewer(), "retry backoff", 5);
    expect(out.results[0].truncated).toBe(false);
  });
});
```

`testViewer()` must return a `Viewer` built through `viewerFromAuthenticatedClaims` for tenant `default` with a principal matching whatever `seedDoc` sets as `ingested_by`. Add it to `ts/tests/helpers/db.ts` if absent.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test ts/tests/snippet.test.ts`
Expected: FAIL on the first assertion — `SNIPPET_OPTS` still says `MaxWords=40`.

- [ ] **Step 3: Widen the snippet and carry the chunk length**

In `ts/search.ts`, replace line 17:

```ts
/**
 * Snippet options, sized for an agent deciding whether to call get_doc — NOT for
 * a human scanning a page. The old MaxWords=40 was ~200 characters, which is
 * below the point where an extract can answer anything, so the agent fetched the
 * whole document and paid for it.
 *
 * ~90 words over 2 fragments is ~6 sentences, which is where Provence (ICLR
 * 2025) measured query-biased extraction holding answer quality while removing
 * 50-80% of the context, and close to the ~60-token extract that scored best in
 * "Searching for Best Practices in RAG". Two fragments rather than one because a
 * question's evidence is frequently split across a document.
 */
export const SNIPPET_OPTS =
  "StartSel=**, StopSel=**, MaxWords=90, MinWords=30, MaxFragments=2, FragmentDelimiter= … ";
```

Add `truncated` to the result interface at `ts/search.ts:116`:

```ts
export interface SearchResult {
  id: string;
  title: string;
  url: string | null;
  tier: string;
  snippet: string;
  /** False means the snippet IS the chunk — there is nothing more to fetch.
   *  An agent that cannot tell these apart fetches defensively, every time. */
  truncated: boolean;
  score?: number;
}
```

In the lexical SQL, add the chunk length to the final SELECT (line 246-247):

```sql
     SELECT doc_id, source, strict_hit, title, url, quality_tier, updated_at,
            length(text) AS text_len,
            ts_headline('english', text, (SELECT loose FROM qq), $2) AS snippet
```

and set the flag when assembling `byDoc` (line 264):

```ts
    const snippet: string = row.snippet;
    // ts_headline returns the WHOLE text when it fits inside the fragment
    // budget, so a plain-length comparison is the exact test for "is there more".
    // The ** markers are the only thing it adds, so strip them before comparing.
    const covered = snippet.replaceAll("**", "").length >= Number(row.text_len);
    byDoc.set(row.doc_id, {
      id: row.doc_id,
      title: row.title,
      url: row.url,
      tier: row.quality_tier,
      snippet,
      truncated: !covered,
      updated: row.updated_at,
    });
```

- [ ] **Step 4: Set the flag on the vector arm too**

At `ts/search.ts:617-628`, the vector arm's fallback snippet is `String(row.text).slice(0, 240)`. Widen it to match and set the flag:

```ts
  for (const row of res.rows) {
    if (!byDoc.has(row.doc_id)) {
      const text = String(row.text);
      // No query terms to bias toward on this arm — the match was semantic — so
      // this is a leading extract, not a headline. Same budget as the lexical
      // arm so an agent sees one consistent snippet size.
      const snippet = text.slice(0, VEC_SNIPPET_CHARS);
      byDoc.set(row.doc_id, {
        id: row.doc_id,
        title: row.title,
        url: row.url,
        tier: row.quality_tier,
        snippet,
        truncated: text.length > snippet.length,
        updated: row.updated_at,
      });
    }
  }
```

and add the constant next to `SNIPPET_OPTS`:

```ts
/** ~90 words at ~6 chars/word, matching SNIPPET_OPTS on the lexical arm. */
export const VEC_SNIPPET_CHARS = 540;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test ts/tests/snippet.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Make fetch-through measurable per result, not per call**

`metrics.vw_two_phase` already divides `get_doc` calls by `search_docs` calls. That answers "how often does a search lead to a fetch"; it does not answer "what fraction of the results we returned were insufficient", which is the snippet-sufficiency signal. `audit_log.result_count` is already recorded and unused for this.

Create `migrations/0022_fetch_through.sql`:

```sql
-- migrations/0022_fetch_through.sql
-- Snippet sufficiency, as a number.
--
-- vw_two_phase divides get_doc CALLS by search CALLS. That is a useful shape
-- metric but it saturates: one fetch after a ten-result search reads the same as
-- ten. The cost question is what FRACTION OF RETURNED RESULTS the agent could
-- not act on from the snippet alone — that is the number a wider snippet is
-- supposed to move, so it is the number to watch when tuning SNIPPET_OPTS.

CREATE VIEW metrics.vw_fetch_through AS
SELECT date_trunc('day', at)::date AS day,
       sum(result_count) FILTER (WHERE tool IN ('search_docs', 'search_code')) AS results_returned,
       count(*) FILTER (WHERE tool = 'get_doc') AS fetches,
       CASE WHEN coalesce(sum(result_count) FILTER (WHERE tool IN ('search_docs', 'search_code')), 0) = 0
            THEN NULL
            ELSE round(count(*) FILTER (WHERE tool = 'get_doc')::numeric
                       / sum(result_count) FILTER (WHERE tool IN ('search_docs', 'search_code')), 3)
       END AS fetch_through
FROM audit_log GROUP BY 1;
```

- [ ] **Step 7: Surface `truncated` through MCP**

Run: `grep -n "snippet" ts/mcp-server.ts ts/contracts/models.ts`

Wherever the `search_docs` tool's output shape is declared (a Zod schema or a mapped object), add `truncated: z.boolean()` alongside `snippet`, and extend the tool description with the sentence:

```
Call get_doc only when a result's `truncated` is true and the snippet does not
already answer the question.
```

This is the steering half of the change. A wider snippet with no instruction to trust it changes nothing.

- [ ] **Step 8: Run the full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean. Other suites asserting on snippet length or on `SearchResult` shape will need updating — widen the expectation, do not delete it.

- [ ] **Step 9: Commit**

```bash
git add ts/search.ts ts/mcp-server.ts migrations/0022_fetch_through.sql ts/tests
git commit -m "feat: snippets an agent can answer from, and a flag when it cannot

MaxWords 40 -> 90 over 2 fragments, plus an explicit truncated flag so
silence means completeness. vw_fetch_through measures whether it worked."
```

---

### Task 5: normalised convex combination instead of weighted RRF

`rrf()` fuses ranks and discards scores, so a 0.95 semantic match and a 0.35 one are indistinguishable if their ranks match. Bruch et al. (arXiv 2210.11934, TOIS 2023) measured convex combination beating RRF in-domain and out-of-domain — 0.454 vs 0.425 nDCG on MS MARCO — and found RRF's own parameters do not transfer across domains, which removes its "no tuning needed" advantage. Elastic's `rrf` retriever gives every arm equal weight by design; per-arm weighting only exists on their `linear` retriever, with normalisers.

**Files:**
- Modify: `ts/core/fusion.ts` (add `combine` and `armWeightCeiling`, keep `rrf`)
- Modify: `ts/core/router.ts` (receives `armWeights`, `CODE_LEANING_ROUTES`, `OFF_LEAN_WEIGHT` from search.ts)
- Modify: `ts/search.ts:70-86` (arm weights move out), `:254-296` (arm assembly and fusion), `:518-630` (`vecArm` return type)
- Modify: `ts/reqs/constants.ts:13-19,26-31,46-69` (floors re-derived off the new scale)
- Test: `ts/tests/fusion.test.ts` (extend; read it first), `ts/tests/reqs-scoring.test.ts:91-141` (re-derive)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `combine(arms: Record<string, Arm>, weights: Record<string, number>): Array<[string, number]>`, where `interface Arm { hits: Array<[string, number]>; min?: number; max?: number }`; `armWeightCeiling(weights: Record<string, number>): number`; `armWeights(route: Route): Record<string, number>` now exported from `ts/core/router.ts`. `vecArm` changes its return type from `Promise<string[] | null>` to `Promise<Array<[string, number]> | null>`.

**Controller ruling (settled before execution):** rescaling fused scores breaks the grounding escalation gate in `ts/reqs/ground.ts`, whose floors are derived from `RRF_K`. The human partner chose to re-derive the floors inside this task rather than defer the fusion change or keep two score scales. Steps 12-14 are that decision; the task is incomplete without them.

- [ ] **Step 1: Write the failing test**

Append to `ts/tests/fusion.test.ts`:

```ts
import { combine } from "../core/fusion.js";

describe("combine", () => {
  it("normalises each arm independently before weighting", () => {
    // Arm A's raw scores are 100x arm B's. Without normalisation A would win
    // outright; with it, the two agree on `x` and it comes first.
    const out = combine(
      {
        a: { hits: [["x", 100], ["y", 50]] },
        b: { hits: [["x", 1], ["z", 0.5]] },
      },
      { a: 1, b: 1 },
    );
    expect(out[0]![0]).toBe("x");
  });

  it("keeps the score distribution, unlike rank fusion", () => {
    // Same ranks, very different scores. A runaway top hit must score higher
    // than a flat one — this is exactly what RRF cannot express.
    const runaway = combine({ a: { hits: [["x", 1.0], ["y", 0.1]] } }, { a: 1 });
    const flat = combine({ a: { hits: [["x", 1.0], ["y", 0.99]] } }, { a: 1 });
    expect(runaway[1]![1]).toBeLessThan(flat[1]![1]);
  });

  it("uses theoretical bounds when given, not the observed spread", () => {
    // With min/max supplied, a single hit keeps its absolute value instead of
    // being normalised to 1.0 by being the only thing in its own arm.
    const out = combine({ v: { hits: [["x", 0.4]], min: 0, max: 1 } }, { v: 1 });
    expect(out[0]![1]).toBeCloseTo(0.4, 6);
  });

  it("scores a document absent from an arm as zero in that arm", () => {
    const out = combine(
      {
        a: { hits: [["x", 1], ["y", 1]] },
        b: { hits: [["x", 1]] },
      },
      { a: 1, b: 1 },
    );
    const byId = new Map(out);
    expect(byId.get("x")!).toBeGreaterThan(byId.get("y")!);
  });

  it("normalises weights so the output stays in [0,1]", () => {
    const out = combine(
      { a: { hits: [["x", 1]] }, b: { hits: [["x", 1]] } },
      { a: 3, b: 7 },
    );
    expect(out[0]![1]).toBeCloseTo(1, 6);
  });

  it("survives an arm where every score is identical", () => {
    const out = combine({ a: { hits: [["x", 5], ["y", 5]] } }, { a: 1 });
    expect(out.map(([id]) => id).sort()).toEqual(["x", "y"]);
    for (const [, s] of out) expect(Number.isFinite(s)).toBe(true);
  });

  it("breaks ties on id, ascending", () => {
    const out = combine({ a: { hits: [["b", 1], ["a", 1]] } }, { a: 1 });
    expect(out.map(([id]) => id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test ts/tests/fusion.test.ts`
Expected: FAIL — `combine` is not exported from `../core/fusion.js`.

- [ ] **Step 3: Implement `combine`**

Append to `ts/core/fusion.ts`:

```ts
/**
 * Convex combination of normalised arm scores.
 *
 * RRF throws away the score distribution: a document that a semantic arm scored
 * 0.95 and one it scored 0.35 fuse identically if their ranks match. Bruch et
 * al. (arXiv 2210.11934, TOIS 2023) measured convex combination beating RRF both
 * in-domain and out-of-domain (0.454 vs 0.425 nDCG on MS MARCO), and found RRF
 * to be parameter-sensitive with parameters that do not transfer across domains
 * — which is the whole of its supposed advantage.
 *
 * Each arm is min-maxed into [0,1] on its own, so a raw ts_rank and a cosine
 * never get compared on their own scales. Where an arm has KNOWN bounds it
 * passes them (`min`/`max`) and gets theoretical min-max, which Bruch prefers:
 * observed min-max lets whichever arm happens to have the sharpest spread in
 * this particular candidate pool rescale everyone else.
 *
 * A document missing from an arm scores 0 there. Agreement across arms is
 * therefore still rewarded, exactly as it was under RRF.
 */
export interface Arm {
  /** [docId, rawScore], any order. */
  hits: Array<[string, number]>;
  /** Theoretical lower bound, when the arm has one. */
  min?: number;
  /** Theoretical upper bound, when the arm has one. */
  max?: number;
}

export function combine(
  arms: Record<string, Arm>,
  weights: Record<string, number> = {},
): Array<[string, number]> {
  const names = Object.keys(arms);
  const total = names.reduce((s, n) => s + (weights[n] ?? 1.0), 0);
  if (total <= 0) return [];

  const scores = new Map<string, number>();
  for (const name of names) {
    const arm = arms[name]!;
    if (arm.hits.length === 0) continue;
    const w = (weights[name] ?? 1.0) / total;
    const raw = arm.hits.map(([, s]) => s);
    const lo = arm.min ?? Math.min(...raw);
    const hi = arm.max ?? Math.max(...raw);
    const span = hi - lo;
    for (const [docId, s] of arm.hits) {
      // A degenerate arm (every score equal, or a single hit with no declared
      // bounds) carries no discriminating information. Giving every member 1.0
      // would let it dominate; 0.5 keeps it as weak, uniform evidence.
      const norm = span > 0 ? Math.min(1, Math.max(0, (s - lo) / span)) : 0.5;
      scores.set(docId, (scores.get(docId) ?? 0) + w * norm);
    }
  }
  return [...scores.entries()].sort(([idA, sA], [idB, sB]) =>
    sB !== sA ? sB - sA : idA < idB ? -1 : idA > idB ? 1 : 0,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test ts/tests/fusion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the pure function**

```bash
git add ts/core/fusion.ts ts/tests/fusion.test.ts
git commit -m "feat: convex-combination fusion alongside rrf

Score-aware fusion, per-arm normalisation, theoretical bounds where an
arm has them. Not yet wired into search."
```

- [ ] **Step 6: Make `vecArm` return scores**

In `ts/search.ts`, change the signature and the final line of `vecArm`:

```ts
async function vecArm(
  client: Db,
  viewer: Viewer,
  query: string,
  limit: number,
  byDoc: Map<string, SearchResult & { updated: Date | null }>,
  embedder?: Embedder,
  sources: string[] | null = null,
): Promise<Array<[string, number]> | null> {
```

and:

```ts
  return res.rows.map((r) => [r.doc_id as string, Number(r.score)] as [string, number]);
```

- [ ] **Step 7: Make the lexical arms carry `ts_rank`**

In `searchDocsInner`, add `rank` to the final SELECT of the lexical query (it is already computed in the `m` CTE, and already used for `ORDER BY`, but not projected):

```sql
     SELECT doc_id, source, strict_hit, title, url, quality_tier, updated_at, rank,
            length(text) AS text_len,
            ts_headline('english', text, (SELECT loose FROM qq), $2) AS snippet
```

Change the list type and population (replacing lines 255-283):

```ts
  const byDoc = new Map<string, SearchResult & { updated: Date | null }>();
  // Four lexical lists: {prose, code} x {matched every term, matched any term}.
  const lists: Record<string, Array<[string, number]>> = {
    fts_prose: [],
    fts_prose_loose: [],
    fts_code: [],
    fts_code_loose: [],
  };
  for (const row of res.rows) {
    if (byDoc.has(row.doc_id)) continue;
    const snippet: string = row.snippet;
    const covered = snippet.replaceAll("**", "").length >= Number(row.text_len);
    byDoc.set(row.doc_id, {
      id: row.doc_id,
      title: row.title,
      url: row.url,
      tier: row.quality_tier,
      snippet,
      truncated: !covered,
      updated: row.updated_at,
    });
    const cls = row.source === "code" ? "fts_code" : "fts_prose";
    const rank = Number(row.rank);
    // A doc matching every term is deliberately placed in BOTH lists, so it
    // collects weight from two arms and outranks partial matches without needing
    // a tuned precision constant anywhere.
    if (row.strict_hit) lists[cls]!.push([row.doc_id, rank]);
    lists[`${cls}_loose`]!.push([row.doc_id, rank]);
  }
  // Separate arms is the actual fix for code crowding: an inflated ts_rank
  // inside a code arm is normalised WITHIN that arm, so it can only ever outrank
  // other code — it cannot evict prose, whatever the raw numbers look like.
  const arms: Record<string, Arm> = {};
  for (const [name, hits] of Object.entries(lists)) {
    // ts_rank has no fixed upper bound, so its arms use observed min-max.
    if (hits.length > 0) arms[name] = { hits };
  }
  try {
    const vec = await vecArm(client, viewer, query, limit, byDoc, embedder, sources);
    // Cosine over unit vectors: the theoretical range is [-1,1], but text
    // embeddings are effectively non-negative, and a negative cosine is not
    // evidence of relevance. Clamping the floor to 0 stops one weakly-negative
    // candidate stretching the scale for everything above it.
    if (vec && vec.length > 0) arms.vec = { hits: vec, min: VEC_SCORE_MIN, max: VEC_SCORE_MAX };
  } catch (err: any) {
    console.error(`vec arm skipped: ${err.message}`); // best-effort: degrade to FTS-only
  }
  const fused = combine(arms, armWeights(decision.route));
```

Add the bounds constants beside `SNIPPET_OPTS`:

```ts
/** Theoretical bounds for the cosine arm. Unit vectors put cosine in [-1,1],
 *  but a negative cosine is not weak relevance, it is none — so the floor is 0.
 *  Named rather than inlined because these are the first thing to sweep once a
 *  golden query set exists. */
export const VEC_SCORE_MIN = 0;
export const VEC_SCORE_MAX = 1;
```

Update the imports at the top of `ts/search.ts`:

```ts
import { type Arm, combine } from "./core/fusion.js";
```

- [ ] **Step 8: Rebalance the arm weights**

`combine` normalises weights to sum to 1, so the existing 0.6/1.0 values keep their *relative* meaning and need no rescaling. But the comment at `ts/search.ts:63-69` describes RRF. Replace it:

```ts
/**
 * Arm weights come from the query router rather than a tuned constant: it
 * already distinguishes a natural-language question from an identifier, path or
 * quoted string, and it is unit-tested. A prose question leans on the prose arm;
 * `retryHandler` or `src/retry.ts` leans on the code arm. Neither is silenced —
 * the loser is down-weighted, not dropped, because excluding an arm on a
 * misrouted query is unrecoverable while down-weighting it is not.
 *
 * combine() normalises these to sum to 1, so only their ratio matters.
 */
```

- [ ] **Step 9: Run the full suite**

Run: `pnpm test`
Expected: PASS. Suites asserting on absolute `score` values will move — scores are now in [0,1] rather than RRF's ~1/60 scale. Update expected values; do not loosen the assertions to `toBeGreaterThan(0)`.

Note that `WEAK_SCORE_GAP = 0.05` at `ts/search.ts:315` is a *relative* cut (`top * (1 - WEAK_SCORE_GAP)`), so it survives the scale change unchanged. Confirm `confidence()`'s tests still pass rather than assuming.

- [ ] **Step 10: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 11: Commit**

```bash
git add ts/search.ts ts/tests
git commit -m "feat: fuse arms by normalised score, not by rank

RRF could not tell a 0.95 semantic match from a 0.35 one. Per-arm
min-max, theoretical bounds on cosine, weights normalised to sum to 1.
Scores are now in [0,1]."
```

- [ ] **Step 12: Re-derive the grounding floors onto the new scale**

**This step is not optional and this task is not complete without it.** `ts/reqs/constants.ts:19-69` derives `groundingTopScoreFloor` (1.5 × `1/(RRF_K+1)` ≈ 0.0246) and `groundingScoreGapFloor` (0.6 × the same ≈ 0.0098) from `RRF_K`, and `ts/reqs/ground.ts:330,333` escalates to a human when `searchDocs`'s `top_score` / `score_gap` fall below them. Steps 1-11 move those scores from the RRF scale to [0,1]. Left alone, every result clears a 0.0246 floor and the escalation gate silently stops escalating.

First, move the arm-weight table out of `ts/search.ts` so `constants.ts` can reach it without importing the search module. Cut `CODE_LEANING_ROUTES`, `OFF_LEAN_WEIGHT` and `armWeights` from `ts/search.ts:70-86` and paste them into `ts/core/router.ts`, exporting `armWeights`. `router.ts` imports only `./ticket.js`, so no cycle is created. Import it back in `ts/search.ts`:

```ts
import { type Route, armWeights, classify } from "./core/router.js";
```

Then add the ceiling helper to `ts/core/fusion.ts`:

```ts
/**
 * The largest share of a fused score any SINGLE arm can contribute when every
 * arm fires.
 *
 * combine() normalises weights to sum to 1, so this is max(w) / sum(w) — the
 * convex-combination analogue of RRF's `1 / (RRF_K + 1)`, and the scale the
 * grounding floors in reqs/constants.ts are derived from. Computed over the FULL
 * arm set on purpose: when fewer arms fire the surviving ones each carry a larger
 * share, so a floor derived from a partial set would drift with the corpus.
 */
export function armWeightCeiling(weights: Record<string, number>): number {
  const vals = Object.values(weights);
  const total = vals.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  return Math.max(...vals) / total;
}
```

Then rewrite the derivation block in `ts/reqs/constants.ts`, replacing the `RRF_K` import, `ONE_ARM_AT_RANK_1`, and both floor entries:

```ts
import { armWeightCeiling } from "../core/fusion.js";
import { armWeights } from "../core/router.js";

/**
 * One retrieval arm's largest possible contribution to a fused score, with every
 * arm firing. combine() normalises the arm weights to sum to 1, so a single arm
 * scoring a document at the top of its own range contributes at most
 * max(w)/sum(w) ≈ 0.238. Every grounding floor below is a multiple of this,
 * which is the only scale a fused `top_score` lives on.
 *
 * Route-invariant: armWeights swaps WHICH arms carry 1.0 and which carry 0.6,
 * never the multiset, so the ceiling is the same on every route. The "docs"
 * route is named here only because the function needs an argument.
 */
const ONE_ARM_ALONE = armWeightCeiling(armWeights("docs"));
```

and the two entries, keeping the surrounding rubric comments but replacing their bodies:

```ts
  /** Retrieval arithmetic: below this top score there is nothing worth reading.
   *
   *  DERIVED, never a chosen decimal. Before migration to convex-combination
   *  fusion these floors sat on the RRF scale, where one arm at rank 1 gave
   *  `1/(RRF_K+1)` ≈ 0.0164 and the achievable ceiling was ≈0.094. combine()
   *  normalises each arm into [0,1] and the weights to sum to 1, so the scale is
   *  now genuinely 0-1: one arm alone contributes ≈0.238, all arms agreeing give
   *  1.0, and `ranking.modifier` scales that by at most TIER_PRIOR.curated 1.15.
   *  `ts/tests/reqs-scoring.test.ts` asserts each floor is strictly below the
   *  achievable ceiling, which is what stops a scale change silently disabling
   *  the gate — as this migration would otherwise have done.
   *
   *  The threshold still means: at least roughly one and a half arms agree this
   *  is the top hit. Retuning the arm weights moves it, because the scale moved. */
  groundingTopScoreFloor: 1.5 * ONE_ARM_ALONE,
  /** Below this gap between rank 1 and rank 5 the sources disagree — escalate.
   *
   *  Same scale, same derivation: the top result must stand clear of the fifth by
   *  a meaningful fraction — 0.6 — of one arm's solo contribution. A gap is a
   *  DIFFERENCE of two fused scores, so it shares the scores' ceiling. */
  groundingScoreGapFloor: 0.6 * ONE_ARM_ALONE,
```

- [ ] **Step 13: Update the floor-derivation tests**

`ts/tests/reqs-scoring.test.ts:91-141` imports `RRF_K` and asserts the floors are derived from it. Replace that import and the two derivation assertions:

```ts
import { armWeightCeiling } from "../core/fusion.js";
import { armWeights } from "../core/router.js";

const ONE_ARM_ALONE = armWeightCeiling(armWeights("docs"));
```

Keep the existing ceiling test — it is the guard that caught the last scale error — and update its ceiling to the new scale: all arms agreeing gives 1.0, times `TIER_PRIOR.curated` = 1.15. Rename the derivation test at line 141 and assert against the new basis:

```ts
  it("both floors are derived from the arm-weight ceiling, not written as decimals", () => {
    expect(REGISTERED_CONSTANTS.groundingTopScoreFloor).toBeCloseTo(1.5 * ONE_ARM_ALONE, 12);
    expect(REGISTERED_CONSTANTS.groundingScoreGapFloor).toBeCloseTo(0.6 * ONE_ARM_ALONE, 12);
  });

  it("the arm-weight ceiling is route-invariant", () => {
    // armWeights swaps which arms carry 1.0 and 0.6 but never the multiset, so a
    // code-leaning query and a prose query calibrate the gate identically.
    for (const route of ["docs", "symbol", "path", "exact", "entity"] as const) {
      expect(armWeightCeiling(armWeights(route))).toBeCloseTo(ONE_ARM_ALONE, 12);
    }
  });
```

Add one test recording the behavioural change this migration makes, so it is asserted rather than discovered:

```ts
  it("a single-arm result can now clear the top-score floor", () => {
    // Under RRF a lone arm contributed 1/(RRF_K+1) and was escalated. Under
    // combine() an arm that is the ONLY one firing is normalised to the whole
    // weight, so it can score 1.0. `arms_contributing` is the signal that
    // distinguishes these, and ground.ts reads it separately — this test exists
    // so that shift is a recorded decision rather than a surprise in production.
    const solo = combine({ vec: { hits: [["x", 0.9]], min: 0, max: 1 } }, armWeights("docs"));
    expect(solo[0]![1]).toBeGreaterThan(REGISTERED_CONSTANTS.groundingTopScoreFloor);
  });
```

- [ ] **Step 14: Run the grounding suites**

Run: `pnpm test ts/tests/reqs-scoring.test.ts ts/tests/reqs-corpus.test.ts`
Expected: PASS. If `reqs-corpus.test.ts` asserts absolute grounding decisions against fixture scores, those decisions may legitimately change — report which ones moved in the task report rather than editing the expectations to match, because a decision flipping from `escalate` to `READ` is exactly the risk this step exists to control.

- [ ] **Step 15: Run the full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 16: Commit**

```bash
git add ts/core/fusion.ts ts/core/router.ts ts/search.ts ts/reqs/constants.ts ts/tests
git commit -m "fix: re-derive grounding floors onto the convex-combination scale

The floors were derived from RRF_K. Rescaling fused scores to [0,1]
without moving them would have left every result clearing the gate and
silently stopped escalation. armWeights moves to router.ts so the pure
constants register can reach it without importing search."
```

- [ ] **Step 17: Retire `rrf()` only if nothing uses it**

Run: `grep -rn "\brrf\b" ts/ scripts/ docs/`

If `rrf` has no remaining callers outside its own tests, leave both the function and its tests in place — it is 20 lines, it documents what the previous behaviour was, and `ts/eval/` may want it as a comparison baseline when the golden query set arrives. Do not delete it in this task.

---

## What this plan deliberately does not do

**No reranker.** Recommendation 4 from the research pairs convex combination with a cross-encoder rerank and a 3–5 document cap, on the strength of "The Power of Noise" (SIGIR 2024) measuring a 24% relative accuracy drop from a *single* related-but-wrong document. That is the right next step, but it needs a decision this plan cannot make for you: a local ONNX cross-encoder (another vendored model, CPU cost per query, matching the existing `LocalEmbedder` pattern) versus a MaaS reranker endpoint (network at query time, and it must be confirmed that MaaS exposes an NV-RerankQA-class model). Both are real designs; they have different latency, air-gap and dependency consequences. Pick one and it becomes a fourth task.

**No result cap change.** `searchDocs(limit = 8)` stays. Cutting to 3–5 is only defensible once the reranker exists to decide *which* 3–5 — cutting first would just drop the tail of an unranked list.

**No golden query set.** Every number in the research is measured against labelled queries. EIL has 2 fixtures. Nothing in this plan can be shown to have *improved* retrieval until a set of ≥30 real queries with labelled gold passages exists; Tasks 1–3 are justified as a correctness fix (the vector arm was not reading the text) and Tasks 4–5 as an evidence-backed design change, but the plan produces no quality measurement and should not be reported as if it had.
