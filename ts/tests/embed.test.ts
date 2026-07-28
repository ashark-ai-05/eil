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
import { afterAll, beforeAll, vi } from "vitest";
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
        id: "jira:issue:PAY-2",
        tenant: "default",
        source: "jira",
        title: "Auth outage",
        hierarchy: [],
        aclGroups: [],
        qualityTier: "authored",
        body: "Sign-in service returned 500s during the rollout.",
        links: [],
      } as any);
      // Stub: query "zzz" -> [1,0,0]; PAY-2 body -> [1,0,0] (nearest); others -> [0,1,0].
      const stubEmbed: Embedder = {
        id: "stub:v2",
        embed: async (texts) =>
          texts.map((t) =>
            t.includes("Sign-in") || t === "zzz"
              ? Float32Array.from([1, 0, 0])
              : Float32Array.from([0, 1, 0]),
          ),
      };
      // embed all chunks with this stub so PAY-2 chunk = [1,0,0]
      const { backfill } = await import("../embed/backfill.js");
      await backfill(c, stubEmbed, { reembed: true });
      const res = await searchDocs(c, localViewer(), "zzz", 8, stubEmbed);
      // "zzz" matches nothing lexically, so only the vec arm can surface PAY-2:
      expect((res.results as any[]).map((r: any) => r.id)).toContain("jira:issue:PAY-2");
    } finally {
      await c.end();
    }
  });

  it("excludes an ACL-restricted doc from the vec arm even when it is the cosine-closest chunk", async () => {
    const { connect } = await import("../db.js");
    const { upsertDocument } = await import("../store.js");
    const { searchDocs } = await import("../search.js");
    const c = await connect();
    try {
      // A doc that shares NO query words and, once embedded, is the exact
      // cosine match for the query — the strongest possible temptation for
      // the vec arm to leak it if visibleSql were ever dropped or bypassed.
      await upsertDocument(c, {
        id: "jira:issue:PAY-3",
        tenant: "default",
        source: "jira",
        title: "Payments incident",
        hierarchy: [],
        aclGroups: [],
        qualityTier: "authored",
        body: "Card processor rejected transactions during the incident.",
        links: [],
      } as any);
      // ingested_by != localViewer().principal AND acl_groups shares nothing
      // with localViewer().groups: fail-closed on both branches of visibleSql.
      await c.query(
        "UPDATE documents SET ingested_by = 'mallory-ingester'," +
          " acl_groups = '[\"restricted-group\"]'::jsonb WHERE id = 'jira:issue:PAY-3'",
      );
      // Stub: query "www" -> [1,0,0]; PAY-3's chunk -> [1,0,0] (exact match,
      // score 1); every other chunk -> [0,1,0] (orthogonal, score 0).
      const stubEmbed: Embedder = {
        id: "stub:v3",
        embed: async (texts) =>
          texts.map((t) =>
            t.includes("Card processor") || t === "www"
              ? Float32Array.from([1, 0, 0])
              : Float32Array.from([0, 1, 0]),
          ),
      };
      const { backfill } = await import("../embed/backfill.js");
      await backfill(c, stubEmbed, { reembed: true });
      const res = await searchDocs(c, localViewer(), "www", 8, stubEmbed);
      const ids = (res.results as any[]).map((r: any) => r.id);
      // Fail-closed proof: PAY-3 is the cosine-closest chunk in the whole
      // corpus yet must never appear, because localViewer() can't see it.
      expect(ids).not.toContain("jira:issue:PAY-3");
    } finally {
      await c.end();
    }
  });

  it("is FTS-only (no throw) when the embed provider errors", async () => {
    const { connect } = await import("../db.js");
    const { searchDocs } = await import("../search.js");
    const { backfill } = await import("../embed/backfill.js");
    const throwing: Embedder = {
      // id MUST match the stored chunks' embed_model so the model-filtered guard
      // passes and `embed()` is actually reached (and throws). A non-matching id
      // would short-circuit at the guard and never exercise the catch path.
      id: "stub:v1",
      embed: async () => {
        throw new Error("no endpoint");
      },
    };
    const c = await connect();
    try {
      // Self-contained: guarantee at least one chunk embedded under THIS id exists
      // so the vec arm's model-filtered guard passes and `throwing.embed()` is
      // actually invoked. Without this the test could pass vacuously via the
      // guard early-return, never reaching the catch path.
      await backfill(c, stub, {}); // stub.id === "stub:v1" === throwing.id
      const embedded = await c.query("SELECT 1 FROM chunks WHERE embedding IS NOT NULL LIMIT 1");
      expect(embedded.rows.length).toBeGreaterThan(0); // sanity: guard will pass

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await searchDocs(c, localViewer(), "authenticate", 8, throwing);
      expect(Array.isArray(res.results as any)).toBe(true);
      // Proves the catch path (not the guard-skip path) actually ran.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("vec arm skipped"));
      errSpy.mockRestore();
    } finally {
      await c.end();
    }
  });
});
