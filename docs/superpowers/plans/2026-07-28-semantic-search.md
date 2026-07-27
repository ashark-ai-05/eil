# Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a semantic (vector) retrieval arm fused with the existing FTS arm via `rrf()`, using extension-free `bytea` float32 embeddings and a pluggable embedder — so work-PC Jira search matches by meaning, with zero pgvector install and full backward compatibility.

**Architecture:** `ts/embed/index.ts` owns the `Embedder` abstraction (fake/http), packing, and cosine. Migration `0007` adds `chunks.embedding bytea` + `chunks.embed_model text`. `ts/embed/backfill.ts` embeds chunks (embed-once). `search.ts` gains a guarded, ACL-correct, best-effort `vec` arm fused via `rrf({ fts, vec })`. Everything degrades to FTS-only when no embeddings exist or the provider is unavailable.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), pg/PGlite, commander, vitest, biome. No new deps.

## Global Constraints

- Node 22+, ESM, strict `tsc`, `.js` import specifiers, no new deps, biome clean.
- **Extension-free:** embeddings are packed float32 in a `bytea` column; cosine in JS. No `CREATE EXTENSION`. Works on PGlite / embedded / system Postgres alike.
- **Backward compatible:** with no embeddings present, search is byte-for-byte the current FTS path (`rrf({ fts })`). Existing search tests stay green.
- **Best-effort vec arm:** any embedder/DB error in the vec arm is caught → FTS-only; search never throws because of embeddings.
- **ACL-correct:** the vec arm reuses `visibleSql`; an invisible chunk never surfaces even if cosine-closest.
- **Embed-once:** backfill embeds only chunks with `embedding IS NULL` or a stale `embed_model` (unless `--reembed`).
- Embedder is **injectable** into backfill and the vec arm (default `getEmbedder()`); tests pass a stub.
- `Embedder` interface is `{ id: string; embed(texts: string[]): Promise<Float32Array[]> }` (dim is an impl detail; packing uses actual array length).

## File Structure

- Create `ts/embed/index.ts` — `Embedder`, `packF32`/`unpackF32`, `cosine`, `FakeEmbedder`, `HttpEmbedder`, `getEmbedder`.
- Create `migrations/0007_embeddings.sql`.
- Create `ts/embed/backfill.ts` — `backfill(client, embedder, opts)`.
- Modify `ts/cli.ts` — `eil embed backfill`.
- Modify `ts/search.ts` — the `vec` arm + `rrf({ fts, vec })`.
- Create `ts/tests/embed.test.ts`; extend `ts/tests/` for backfill + vec arm (PGlite).
- Modify `README.md`.

---

### Task 1: Embedder abstraction, packing, cosine (pure)

**Files:**
- Create: `ts/embed/index.ts`
- Test: `ts/tests/embed.test.ts`

**Interfaces:**
- Produces: `interface Embedder { id: string; embed(texts: string[]): Promise<Float32Array[]> }`; `packF32(v: Float32Array): Buffer`; `unpackF32(b: Buffer): Float32Array`; `cosine(a: Float32Array, b: Float32Array): number`; `class FakeEmbedder`; `class HttpEmbedder`; `getEmbedder(name?: string): Embedder`.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/embed.test.ts
import { describe, expect, it } from "vitest";
import { FakeEmbedder, cosine, getEmbedder, packF32, unpackF32 } from "../embed/index.js";

describe("packing", () => {
  it("round-trips float32 vectors", () => {
    const v = Float32Array.from([0.5, -1.25, 3.0, 0]);
    const back = unpackF32(packF32(v));
    expect([...back]).toEqual([...v]);
    expect(packF32(v).length).toBe(16);
  });
});

describe("cosine", () => {
  it("is 1 for identical, 0 for orthogonal, -1 for opposite", () => {
    const a = Float32Array.from([1, 0, 0]);
    expect(cosine(a, Float32Array.from([1, 0, 0]))).toBeCloseTo(1, 6);
    expect(cosine(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0, 6);
    expect(cosine(a, Float32Array.from([-1, 0, 0]))).toBeCloseTo(-1, 6);
  });
  it("returns 0 for a zero vector", () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe("FakeEmbedder", () => {
  it("is deterministic, unit-norm, and distinct per text", async () => {
    const e = new FakeEmbedder(64);
    const [a1] = await e.embed(["login is broken"]);
    const [a2] = await e.embed(["login is broken"]);
    const [b] = await e.embed(["deploy the release"]);
    expect([...a1!]).toEqual([...a2!]); // deterministic
    expect(cosine(a1!, a1!)).toBeCloseTo(1, 5); // unit norm
    expect(cosine(a1!, b!)).toBeLessThan(0.99); // distinct
    expect(e.id).toBe("fake:hash:64");
  });
});

describe("getEmbedder", () => {
  it("selects fake and rejects unknown", () => {
    expect(getEmbedder("fake").id).toBe("fake:hash:64");
    expect(() => getEmbedder("bogus")).toThrow(/unknown embed provider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/embed.test.ts`
Expected: FAIL — cannot resolve `../embed/index.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ts/embed/index.ts
/**
 * Embeddings for the semantic (vector) retrieval arm. Extension-free: vectors
 * are packed float32 (bytea) and cosine runs in-process. Pluggable provider
 * mirrors ts/llm/index.ts (EIL_LLM_PROVIDER -> EIL_EMBED_PROVIDER).
 */

export interface Embedder {
  /** stable "provider:model" id, stamped into chunks.embed_model for staleness */
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function packF32(v: Float32Array): Buffer {
  const b = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i]!, i * 4);
  return b;
}

export function unpackF32(b: Buffer): Float32Array {
  const out = new Float32Array(b.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic, no-network embedder for tests/CI and offline pipeline trials.
 *  NOT semantically meaningful — hash-seeded unit vectors. */
export class FakeEmbedder implements Embedder {
  readonly id: string;
  private readonly dim: number;
  constructor(dim = 64) {
    this.dim = dim;
    this.id = `fake:hash:${dim}`;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      let norm = 0;
      for (let i = 0; i < this.dim; i++) {
        v[i] = (hash32(`${t}#${i}`) / 0xffffffff) * 2 - 1;
        norm += v[i]! * v[i]!;
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < this.dim; i++) v[i]! /= norm;
      return v;
    });
  }
}

/** OpenAI-compatible embeddings over an internal gateway (data stays in-org). */
export class HttpEmbedder implements Embedder {
  readonly id: string;
  private readonly base: string;
  private readonly model: string;
  private readonly key?: string;
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) {
    this.base = (process.env.EIL_EMBED_BASE_URL ?? process.env.EIL_MAAS_BASE_URL ?? "").replace(
      /\/+$/,
      "",
    );
    if (!this.base)
      throw new Error("http embedder needs EIL_EMBED_BASE_URL (or EIL_MAAS_BASE_URL)");
    this.model = process.env.EIL_EMBED_MODEL ?? "text-embedding-3-small";
    this.key = process.env.EIL_EMBED_API_KEY;
    this.id = `http:${this.model}`;
    this.fetcher = fetcher;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await this.fetcher(`${this.base}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`embeddings endpoint ${res.status}`);
    const data: any = await res.json();
    const vecs = (data.data ?? []).map((d: any) => Float32Array.from(d.embedding as number[]));
    if (vecs.length !== texts.length) throw new Error("embedding count mismatch");
    return vecs;
  }
}

/** Per-call name > EIL_EMBED_PROVIDER env > http default. */
export function getEmbedder(name?: string): Embedder {
  const selected = name ?? process.env.EIL_EMBED_PROVIDER ?? "http";
  switch (selected) {
    case "fake":
      return new FakeEmbedder();
    case "http":
      return new HttpEmbedder();
    default:
      throw new Error(`unknown embed provider: '${selected}' (expected http | fake)`);
  }
}
```

- [ ] **Step 4: Add an HttpEmbedder test with a mock fetch**

```ts
// append to ts/tests/embed.test.ts
import { HttpEmbedder } from "../embed/index.js";

describe("HttpEmbedder", () => {
  it("POSTs OpenAI-compatible and parses embeddings", async () => {
    process.env.EIL_EMBED_BASE_URL = "https://gw.example.com/v1";
    process.env.EIL_EMBED_MODEL = "nomic-embed";
    let seenBody: any;
    const fetcher = (async (_url: any, init: any) => {
      seenBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const e = new HttpEmbedder(fetcher);
    const out = await e.embed(["a", "b"]);
    expect(seenBody).toEqual({ model: "nomic-embed", input: ["a", "b"] });
    expect([...out[0]!]).toEqual([0.1, 0.2].map((x) => Math.fround(x)));
    expect(e.id).toBe("http:nomic-embed");
    delete process.env.EIL_EMBED_BASE_URL;
    delete process.env.EIL_EMBED_MODEL;
  });
});
```

- [ ] **Step 5: Run tests + typecheck/lint**

Run: `pnpm exec vitest run ts/tests/embed.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add ts/embed/index.ts ts/tests/embed.test.ts
git commit -m "embed: Embedder abstraction (fake/http), float32 packing, cosine"
```

---

### Task 2: Migration — embedding columns

**Files:**
- Create: `migrations/0007_embeddings.sql`
- Test: covered by Task 3/4 PGlite migrate; add a one-line assertion here.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0007_embeddings.sql
-- Semantic search: extension-free vector storage on chunks. `embedding` is
-- packed float32 (little-endian bytea); cosine runs in-process. No pgvector.
ALTER TABLE chunks ADD COLUMN embedding   bytea;
ALTER TABLE chunks ADD COLUMN embed_model text;
```

- [ ] **Step 2: Verify it applies on PGlite**

Run:
```bash
EIL_DATABASE_URL=pglite://.eil-m pnpm -s eil db migrate && \
  EIL_DATABASE_URL=pglite://.eil-m pnpm -s eil db migrate  # idempotent: 2nd = up to date
rm -rf .eil-m
```
Expected: first run applies `0007`, second prints `up to date`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0007_embeddings.sql
git commit -m "migration 0007: chunks.embedding (bytea) + embed_model"
```

---

### Task 3: Backfill routine + `eil embed backfill`

**Files:**
- Create: `ts/embed/backfill.ts`
- Modify: `ts/cli.ts`
- Test: `ts/tests/embed.test.ts` (PGlite + stub embedder)

**Interfaces:**
- Consumes: `Embedder`, `packF32` (Task 1); `Db` (`ts/db.js`).
- Produces: `backfill(client: Db, embedder: Embedder, opts: { batch?: number; reembed?: boolean }): Promise<{ embedded: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/embed.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { Embedder } from "../embed/index.js";
import { backfill } from "../embed/backfill.js";

const dir = mkdtempSync(join(tmpdir(), "eil-embed-"));
beforeAll(async () => {
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  const { connect, migrate } = await import("../db.js");
  const { upsertDocument } = await import("../store.js");
  const c = await connect();
  await migrate(c);
  await upsertDocument(c, {
    id: "jira:issue:PAY-1",
    tenant: "default",
    source: "jira",
    title: "Login fails",
    hierarchy: [],
    aclGroups: [],
    qualityTier: "authored",
    body: "Users cannot authenticate after the deploy.",
    links: [],
  } as any);
  await c.end();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stub: Embedder = { id: "stub:v1", embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) };

describe("backfill", () => {
  it("embeds NULL chunks and is embed-once", async () => {
    const { connect } = await import("../db.js");
    const c = await connect();
    try {
      const first = await backfill(c, stub, {});
      expect(first.embedded).toBeGreaterThan(0);
      const row = await c.query(
        "SELECT embedding, embed_model FROM chunks WHERE doc_id = 'jira:issue:PAY-1' ORDER BY seq LIMIT 1",
      );
      expect(row.rows[0].embedding).not.toBeNull();
      expect(row.rows[0].embed_model).toBe("stub:v1");
      const second = await backfill(c, stub, {});
      expect(second.embedded).toBe(0); // already current
    } finally {
      await c.end();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/embed.test.ts`
Expected: FAIL — cannot resolve `../embed/backfill.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ts/embed/backfill.ts
/** Embed chunks for the semantic arm. Embed-once: only NULL/stale rows unless
 *  --reembed. Provider errors abort (no partial-silent). */
import type { Db } from "../db.js";
import { type Embedder, packF32 } from "./index.js";

export async function backfill(
  client: Db,
  embedder: Embedder,
  opts: { batch?: number; reembed?: boolean },
): Promise<{ embedded: number }> {
  const batch = opts.batch ?? 64;
  const rows = (
    await client.query(
      opts.reembed
        ? "SELECT doc_id, seq, text FROM chunks ORDER BY doc_id, seq"
        : "SELECT doc_id, seq, text FROM chunks WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $1 ORDER BY doc_id, seq",
      opts.reembed ? [] : [embedder.id],
    )
  ).rows as Array<{ doc_id: string; seq: number; text: string }>;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const vecs = await embedder.embed(slice.map((r) => r.text));
    for (let j = 0; j < slice.length; j++) {
      await client.query(
        "UPDATE chunks SET embedding = $1, embed_model = $2 WHERE doc_id = $3 AND seq = $4",
        [packF32(vecs[j]!), embedder.id, slice[j]!.doc_id, slice[j]!.seq],
      );
      embedded += 1;
    }
    console.log(`  embedded ${Math.min(i + batch, rows.length)}/${rows.length}`);
  }
  return { embedded };
}
```

- [ ] **Step 4: Add the CLI command**

In `ts/cli.ts`, before `program.parseAsync`:

```ts
const embed = program.command("embed").description("Embeddings for semantic search");
embed
  .command("backfill")
  .description("Embed catalog chunks so search gains a semantic (vector) arm")
  .option("--batch <n>", "batch size", "64")
  .option("--reembed", "re-embed every chunk (e.g. after changing the model)")
  .action(async (opts) => {
    const { getEmbedder } = await import("./embed/index.js");
    const { backfill } = await import("./embed/backfill.js");
    const embedder = getEmbedder();
    const client = await connect();
    try {
      const r = await backfill(client, embedder, {
        batch: Number(opts.batch),
        reembed: !!opts.reembed,
      });
      console.log(`embedded ${r.embedded} chunks (provider ${embedder.id})`);
    } finally {
      await client.end();
    }
  });
```

- [ ] **Step 5: Run tests + typecheck/lint**

Run: `pnpm exec vitest run ts/tests/embed.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add ts/embed/backfill.ts ts/cli.ts ts/tests/embed.test.ts
git commit -m "embed: backfill routine + `eil embed backfill` (embed-once)"
```

---

### Task 4: The vec arm in search.ts (fused via rrf, ACL-correct, degrading)

**Files:**
- Modify: `ts/search.ts`
- Test: `ts/tests/` (PGlite + stub embedder) — add to `ts/tests/embed.test.ts` or a search test file.

**Interfaces:**
- Consumes: `cosine`, `unpackF32`, `getEmbedder`, `Embedder` (Task 1); `rrf` (existing); `visibleSql`, `tenantOf` (existing in search.ts).
- Produces: `searchDocs` gains an optional trailing `embedder?: Embedder` param; internal `vecArm(...)` helper. Behavior: FTS-only unless embeddings exist AND embedding succeeds.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/embed.test.ts (reuses the beforeAll DB + a second doc)
import { localViewer } from "../search.js";

describe("vec arm fusion", () => {
  it("surfaces a lexically-disjoint doc via cosine and respects ACL", async () => {
    const { connect } = await import("../db.js");
    const { upsertDocument } = await import("../store.js");
    const { searchDocs } = await import("../search.js");
    const c = await connect();
    try {
      // A doc that shares NO query words but should match by vector.
      await upsertDocument(c, {
        id: "jira:issue:PAY-2", tenant: "default", source: "jira", title: "Auth outage",
        hierarchy: [], aclGroups: [], qualityTier: "authored",
        body: "Sign-in service returned 500s during the rollout.", links: [],
      } as any);
      // Stub: query "zzz" -> [1,0,0]; PAY-2 body -> [1,0,0] (nearest); others -> [0,1,0].
      const stubEmbed: Embedder = {
        id: "stub:v2",
        embed: async (texts) =>
          texts.map((t) =>
            t.includes("Sign-in") || t === "zzz" ? Float32Array.from([1, 0, 0]) : Float32Array.from([0, 1, 0]),
          ),
      };
      // embed all chunks with this stub so PAY-2 chunk = [1,0,0]
      const { backfill } = await import("../embed/backfill.js");
      await backfill(c, stubEmbed, { reembed: true });
      const res = await searchDocs(c, localViewer(), "zzz", 8, stubEmbed);
      // "zzz" matches nothing lexically, so only the vec arm can surface PAY-2:
      expect(res.results.map((r: any) => r.id)).toContain("jira:issue:PAY-2");
    } finally {
      await c.end();
    }
  });

  it("is FTS-only (no throw) when embeddings are absent or provider errors", async () => {
    const { connect } = await import("../db.js");
    const { searchDocs } = await import("../search.js");
    const throwing: Embedder = { id: "boom", embed: async () => { throw new Error("no endpoint"); } };
    const c = await connect();
    try {
      // still returns FTS results for a lexical query without throwing
      const res = await searchDocs(c, localViewer(), "authenticate", 8, throwing);
      expect(Array.isArray(res.results)).toBe(true);
    } finally {
      await c.end();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/embed.test.ts`
Expected: FAIL — `searchDocs` ignores the embedder / has no vec arm.

- [ ] **Step 3: Write minimal implementation**

In `ts/search.ts`: add imports, extend `searchDocs`, add `vecArm`.

Add near the top imports:
```ts
import { type Embedder, cosine, getEmbedder, unpackF32 } from "./embed/index.js";
```

Change the fusion block. Replace:
```ts
  const fused = rrf({ fts: [...byDoc.keys()] });
```
with:
```ts
  const arms: Record<string, string[]> = { fts: [...byDoc.keys()] };
  try {
    const vec = await vecArm(client, viewer, query, limit, byDoc, embedder);
    if (vec && vec.length > 0) arms.vec = vec;
  } catch (err: any) {
    console.error(`vec arm skipped: ${err.message}`); // best-effort: degrade to FTS-only
  }
  const fused = rrf(arms);
```

Add `embedder?: Embedder` as the last parameter of `searchDocs` (keep the existing params/order; append). Then add the helper (place near the bottom of the module, using the existing `visibleSql`/`tenantOf`/`SearchResult` in scope):

```ts
/** Best-effort semantic arm: cosine over ACL-visible embedded chunks. Returns a
 *  ranked docId list (best chunk per doc) and augments `byDoc` for vec-only
 *  docs. Returns null when nothing is embedded. Reuses visibleSql for ACL. */
async function vecArm(
  client: Db,
  viewer: Viewer,
  query: string,
  limit: number,
  byDoc: Map<string, SearchResult & { updated: Date | null }>,
  embedder?: Embedder,
): Promise<string[] | null> {
  const has = await client.query("SELECT 1 FROM chunks WHERE embedding IS NOT NULL LIMIT 1");
  if (has.rows.length === 0) return null; // nothing embedded -> pure FTS
  const emb = embedder ?? getEmbedder(); // may throw if misconfigured -> caught by caller
  const qv = (await emb.embed([query]))[0]!;
  const res = await client.query(
    `SELECT c.doc_id, c.text, c.embedding, d.title, d.url, d.quality_tier, d.updated_at
     FROM chunks c JOIN documents d ON d.id = c.doc_id
     WHERE c.embedding IS NOT NULL AND ${visibleSql(1, 2, 3)}`,
    [viewer.principal, viewer.groups, tenantOf(viewer)],
  );
  const best = new Map<string, { score: number; row: any }>();
  for (const row of res.rows) {
    const score = cosine(qv, unpackF32(row.embedding as Buffer));
    const cur = best.get(row.doc_id);
    if (!cur || score > cur.score) best.set(row.doc_id, { score, row });
  }
  const ranked = [...best.entries()]
    .sort((a, b) => (b[1].score !== a[1].score ? b[1].score - a[1].score : a[0] < b[0] ? -1 : 1))
    .slice(0, limit * 3);
  for (const [docId, { row }] of ranked) {
    if (!byDoc.has(docId)) {
      byDoc.set(docId, {
        id: docId,
        title: row.title,
        url: row.url,
        tier: row.quality_tier,
        snippet: String(row.text).slice(0, 240),
        updated: row.updated_at,
      });
    }
  }
  return ranked.map(([docId]) => docId);
}
```
(If `Viewer`/`Db` types aren't already imported in search.ts, add them from their modules; check the file's existing imports first and reuse.)

- [ ] **Step 4: Run tests + regression + typecheck/lint**

Run:
```bash
pnpm exec vitest run ts/tests/embed.test.ts
EIL_DATABASE_URL=pglite://.eil-s pnpm exec vitest run && rm -rf .eil-s   # full suite incl. existing search tests (FTS regression)
pnpm typecheck && pnpm lint
```
Expected: new vec-arm tests pass; all existing search tests stay green (no embeddings in those → FTS-only path unchanged).

- [ ] **Step 5: Commit**

```bash
git add ts/search.ts ts/tests/embed.test.ts
git commit -m "search: semantic vec arm fused via rrf (ACL-correct, degrades to FTS-only)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Semantic search" subsection**

After the search-related content (near the Observability or Live-connectors section), add:

```markdown
## Semantic search (vector arm)

Search fuses lexical FTS with a **semantic (vector) arm** via reciprocal-rank
fusion — so "login is broken" can find "authentication failure." It's
**off until you embed**, then automatic; nothing changes for pure-FTS setups.

```sh
# point at any OpenAI-compatible embeddings endpoint (internal gateway keeps
# data in-org); falls back to EIL_MAAS_BASE_URL if EIL_EMBED_BASE_URL is unset
export EIL_EMBED_BASE_URL=https://your-gateway/v1
export EIL_EMBED_MODEL=nomic-embed-text
pnpm eil embed backfill        # embed existing chunks (embed-once)
pnpm eil search "why do payments get stuck"   # now fuses FTS + vector
```

- **Extension-free**: embeddings are packed float32 in a `bytea` column, cosine
  runs in-process — works on every Postgres tier (incl. zero-install PGlite)
  with no `CREATE EXTENSION` and no admin. Brute-force is fine at personal scale;
  pgvector/HNSW is a drop-in upgrade later.
- **Pluggable embedder** via `EIL_EMBED_PROVIDER` (`http` default | `fake` for
  offline trials). Re-run `embed backfill` after ingesting more; `--reembed`
  after changing the model.
- **Degrades safely**: if the endpoint is down or nothing is embedded yet,
  search silently stays lexical-only.
```
```

- [ ] **Step 2: Update Status**

```markdown
- [x] Semantic search: extension-free vector arm (bytea float32 + cosine) fused with FTS via rrf; `eil embed backfill`, pluggable embedder
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: semantic search (vector arm + embed backfill)"
```

---

## Self-Review

**Spec coverage:**
- Extension-free bytea storage → Task 2 (migration), Task 1 (pack/unpack). ✓
- Pluggable embedder (fake/http, injectable) → Task 1; injected in Tasks 3-4. ✓
- Backfill embed-once + `--reembed` → Task 3. ✓
- Vec arm fused via rrf, ACL-correct, degrading → Task 4. ✓
- Backward compatible (FTS-only when no embeddings) → Task 4 (`has` guard), regression run. ✓
- Docs + Status → Task 5. ✓

**Placeholder scan:** none — full code in every code step; verify steps have commands + expected output.

**Type consistency:** `Embedder { id; embed }`, `packF32`/`unpackF32`, `cosine`, `getEmbedder`, `backfill(client, embedder, opts)`, `searchDocs(..., embedder?)` and the `vecArm` helper are consistent across tasks and call sites. `embed_model` stamped = `embedder.id` in both backfill and the staleness `WHERE`.
