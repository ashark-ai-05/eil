/**
 * Embeddings for the semantic (vector) retrieval arm. Extension-free: vectors
 * are stored unit-normalized as float4[] (migration 0008) so cosine reduces to
 * a dot product Postgres can compute itself — scoring, best-chunk-per-doc and
 * the top-N cut all run in SQL. Pluggable provider mirrors ts/llm/index.ts
 * (EIL_LLM_PROVIDER -> EIL_EMBED_PROVIDER).
 */

import { fileURLToPath } from "node:url";

export interface Embedder {
  /** stable "provider:model" id, stamped into chunks.embed_model for staleness */
  readonly id: string;
  /**
   * Roughly how many characters of a text actually reach the model. Text past
   * this is silently discarded by the tokenizer — no error, no warning, just a
   * vector that ignores it. Measured against the vendored MiniLM: two 3200-char
   * texts differing ONLY in their tails embed to cosine 1.000000, i.e. the tails
   * are entirely invisible. Exposed so the chunker and the integrity audit can
   * see the limit instead of each assuming one.
   */
  readonly windowChars: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Vectors are stored unit-normalized so that the SQL scorer can use a plain dot
 * product instead of a full cosine. Cosine is scale-invariant, so normalizing on
 * write changes no ranking — but it does mean every writer must go through here,
 * including HttpEmbedder, whose gateway is not guaranteed to normalize.
 */
export function unitNorm(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n === 0) return v; // a zero vector stays zero; it scores 0 against anything
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** float4[] wire form for pg / PGlite — the storage format since migration 0008. */
export const toVec = (v: Float32Array): number[] => Array.from(unitNorm(v));

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
  readonly windowChars = Number.MAX_SAFE_INTEGER; // hashes the whole string
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
  /** Gateway models are typically 8k tokens; conservative default, overridable. */
  readonly windowChars = Number(process.env.EIL_EMBED_WINDOW_CHARS ?? 8_000);
  private readonly base: string;
  private readonly model: string;
  private readonly key: string | undefined;
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) {
    this.base = (process.env.EIL_EMBED_BASE_URL ?? process.env.EIL_MAAS_BASE_URL ?? "").replace(
      /\/+$/,
      "",
    );
    if (!this.base)
      throw new Error("http embedder needs EIL_EMBED_BASE_URL (or EIL_MAAS_BASE_URL)");
    this.model = process.env.EIL_EMBED_MODEL ?? "text-embedding-3-small";
    this.key = process.env.EIL_EMBED_API_KEY ?? undefined;
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
/** In-process embeddings via Transformers.js (ONNX) — no network at query time,
 *  data never leaves the machine. The model (default all-MiniLM-L6-v2, 384-dim)
 *  downloads once from the HF hub and is cached; set EIL_EMBED_CACHE to a local
 *  dir to run air-gapped. `@huggingface/transformers` is an optional dependency,
 *  loaded lazily so the core install stays lean. */
/**
 * Characters that reach each known local model. MiniLM-L6 stops at 256 TOKENS;
 * at ~4 chars/token that is ~1024 characters, which the measurement above
 * corroborates (the tail still moved the vector at 1600 chars but not at 3200).
 * A model not listed here gets the conservative MiniLM figure rather than an
 * optimistic guess, because guessing high reintroduces the silent-truncation bug.
 */
const MODEL_WINDOW_CHARS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 1_024,
};
const DEFAULT_WINDOW_CHARS = 1_024;

export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly windowChars: number;
  private readonly model: string;
  private readonly modelsDir: string;
  private pipe: Promise<any> | null = null;
  constructor() {
    this.model = process.env.EIL_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
    this.id = `local:${this.model}:q8`;
    this.windowChars = Number(
      process.env.EIL_EMBED_WINDOW_CHARS ?? MODEL_WINDOW_CHARS[this.model] ?? DEFAULT_WINDOW_CHARS,
    );
    // The model is VENDORED in the repo (models/<model>/), so embedding is fully
    // local — no Hugging Face hub call ever. Resolve it relative to this module
    // (ts/embed/ -> repo root) so cwd doesn't matter.
    this.modelsDir = fileURLToPath(new URL("../../models", import.meta.url));
  }
  private async pipeline(): Promise<any> {
    if (!this.pipe) {
      this.pipe = (async () => {
        let mod: any;
        try {
          const name = "@huggingface/transformers"; // variable specifier: optional dep
          mod = await import(name);
        } catch {
          throw new Error(
            "local embedder needs @huggingface/transformers — add it with:\n  pnpm add @huggingface/transformers",
          );
        }
        // Load the vendored model from disk; forbid ALL network by default so a
        // blocked huggingface.co can never break ingestion. EIL_EMBED_CACHE
        // overrides the model dir; set EIL_EMBED_ALLOW_REMOTE=1 to opt back into
        // hub downloads (e.g. to pull a different EIL_EMBED_MODEL).
        mod.env.localModelPath = process.env.EIL_EMBED_CACHE ?? this.modelsDir;
        mod.env.allowLocalModels = true;
        mod.env.allowRemoteModels = !!process.env.EIL_EMBED_ALLOW_REMOTE;
        return mod.pipeline("feature-extraction", this.model, { dtype: "q8" });
      })();
    }
    return this.pipe;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.pipeline();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    const rows = out.tolist() as number[][];
    return rows.map((r) => Float32Array.from(r));
  }
}

function build(name?: string): Embedder {
  const selected = name ?? process.env.EIL_EMBED_PROVIDER ?? "local";
  switch (selected) {
    case "local":
      return new LocalEmbedder();
    case "fake":
      return new FakeEmbedder();
    case "http":
      return new HttpEmbedder();
    default:
      throw new Error(`unknown embed provider: '${selected}' (expected local | http | fake)`);
  }
}

let cached: Embedder | null = null;

/**
 * Construction is cheap; the ONNX pipeline behind LocalEmbedder is not. It is
 * cached on the INSTANCE and built lazily on first embed(), so handing back a
 * fresh instance per call reloaded the model on every single search — measured
 * 1192ms cold and ~270-300ms warm, against ~4ms for a reused instance. searchDocs
 * calls this per query, so that was 60-75x of avoidable latency on every search.
 *
 * The cache key is `.id`, not the provider name, and that choice is load-bearing.
 * `id` encodes provider AND model (`local:<model>:q8`), and it is the same value
 * stamped into chunks.embed_model and matched by vecArm. Keying on the provider
 * would let an EIL_EMBED_MODEL switch keep serving vectors from the old model
 * while search believed they came from the new one — finite, meaningless cosine
 * scores. Keying on `id` makes that structurally impossible rather than
 * something a comment has to warn about.
 */
export function getEmbedder(name?: string): Embedder {
  const fresh = build(name);
  if (cached && cached.id === fresh.id) return cached;
  cached = fresh;
  return fresh;
}

/** Drop the memoized embedder. For tests that switch providers mid-process. */
export function resetEmbedderCache(): void {
  cached = null;
}
