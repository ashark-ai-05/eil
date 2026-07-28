/**
 * Embeddings for the semantic (vector) retrieval arm. Extension-free: vectors
 * are packed float32 (bytea) and cosine runs in-process. Pluggable provider
 * mirrors ts/llm/index.ts (EIL_LLM_PROVIDER -> EIL_EMBED_PROVIDER).
 */

import { fileURLToPath } from "node:url";

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

export function unpackF32(b: Buffer | Uint8Array | ArrayBuffer): Float32Array {
  const buf = b instanceof ArrayBuffer ? new Uint8Array(b) : b;
  const out = new Float32Array(buf.length >> 2);
  for (let i = 0; i < out.length; i++) {
    // Handle both Node.js Buffer (readFloatLE) and Uint8Array
    const offset = i * 4;
    if ("readFloatLE" in buf) {
      out[i] = (buf as Buffer).readFloatLE(offset);
    } else {
      // Uint8Array: manually read 4 bytes as little-endian float32
      const u8 = buf as Uint8Array;
      const view = new DataView(u8.buffer, u8.byteOffset + offset, 4);
      out[i] = view.getFloat32(0, true);
    }
  }
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
export class LocalEmbedder implements Embedder {
  readonly id: string;
  private readonly model: string;
  private readonly modelsDir: string;
  private pipe: Promise<any> | null = null;
  constructor() {
    this.model = process.env.EIL_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
    this.id = `local:${this.model}:q8`;
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

export function getEmbedder(name?: string): Embedder {
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
