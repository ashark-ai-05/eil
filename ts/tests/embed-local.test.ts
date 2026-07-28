/**
 * Smoke test for the REAL local embedder — the in-process Transformers.js /
 * ONNX path behind `EIL_EMBED_PROVIDER=local`.
 *
 * embed.test.ts covers packing, cosine, and the fake + http providers, but
 * nothing there ever loads the ONNX runtime. That gap is not theoretical: the
 * runtime's native bindings are unpacked at install time by a transitive
 * dependency (onnxruntime-node -> adm-zip), so a routine security bump of a
 * package nobody has heard of can silently break every semantic search while
 * the whole suite stays green.
 *
 * The model is vendored under models/, so this runs fully offline in ~2s.
 * Skipped only when the optional @huggingface/transformers dep is absent.
 */

import { describe, expect, it } from "vitest";
import { cosine, getEmbedder } from "../embed/index.js";

// Resolved at collection time so an absent optional dep reports as a real
// skip rather than as silently-passing tests.
let available = true;
try {
  const name = "@huggingface/transformers"; // variable specifier: optional dep
  await import(name);
} catch {
  available = false;
}

const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe.skipIf(!available)("LocalEmbedder (vendored ONNX model)", () => {
  it("loads the runtime and produces normalized 384-dim vectors", async () => {
    const e = getEmbedder("local");
    expect(e.id).toBe("local:Xenova/all-MiniLM-L6-v2:q8");

    const [v] = await e.embed(["payment retries back off exponentially"]);
    expect(v).toBeDefined();
    expect(v!.length).toBe(384);
    // the pipeline is configured with normalize:true — a garbage load would not
    // land on the unit sphere
    expect(norm(v!)).toBeCloseTo(1, 3);
    expect(v!.some((x) => x !== 0)).toBe(true);
    expect(v!.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("is deterministic for the same text", async () => {
    const e = getEmbedder("local");
    const [a] = await e.embed(["deterministic input"]);
    const [b] = await e.embed(["deterministic input"]);
    expect(cosine(a!, b!)).toBeCloseTo(1, 6);
  });

  it("puts a paraphrase nearer than an unrelated sentence", async () => {
    // This is the assertion that actually proves the model computed something
    // meaningful rather than merely returning well-shaped noise.
    const e = getEmbedder("local");
    const [a, para, unrelated] = await e.embed([
      "payment retries back off exponentially",
      "the billing service retries failed charges with increasing delays",
      "the office coffee machine is broken",
    ]);
    const near = cosine(a!, para!);
    const far = cosine(a!, unrelated!);
    // observed on the vendored q8 model: ~0.50 vs ~0.08 — assert the ordering
    // with a wide margin so a future model swap does not make this brittle
    expect(near).toBeGreaterThan(far + 0.2);
    expect(near).toBeGreaterThan(0.3);
  });
});
