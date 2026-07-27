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

import { HttpEmbedder } from "../embed/index.js";

describe("HttpEmbedder", () => {
  it("POSTs OpenAI-compatible and parses embeddings", async () => {
    process.env.EIL_EMBED_BASE_URL = "https://gw.example.com/v1";
    process.env.EIL_EMBED_MODEL = "nomic-embed";
    let seenBody: any;
    const fetcher = (async (_url: any, init: any) => {
      seenBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
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
