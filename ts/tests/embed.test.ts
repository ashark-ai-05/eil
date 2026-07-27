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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { backfill } from "../embed/backfill.js";
import type { Embedder } from "../embed/index.js";

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
}, 30000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stub: Embedder = {
  id: "stub:v1",
  embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])),
};

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
