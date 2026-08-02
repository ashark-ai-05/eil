import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import { expand, getDoc, searchDocs, viewerFromAuthenticatedClaims } from "../search.js";
import { getCursor, setCursor, upsertDocument } from "../store.js";
import { callTool } from "../tools.js";

let client: Db;
let dataDir: string;
let savedUrl: string | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "eil-tenant-"));
  savedUrl = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
  client = await connect();
  await migrate(client);
});

afterAll(async () => {
  await client.end();
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

const doc = (tenant: string, body: string) =>
  CanonicalDoc.parse({
    id: "confluence:page:12345",
    tenant,
    source: "confluence",
    title: `Runbook ${tenant}`,
    body,
    aclGroups: [],
  });

describe("tenant-scoped catalog identity", () => {
  it("retains the same canonical ID independently per tenant", async () => {
    await upsertDocument(client, doc("alpha", "alpha-only runbook"));
    await upsertDocument(client, doc("bravo", "bravo-only runbook"));

    const alpha = viewerFromAuthenticatedClaims({ principal: "outsider", tenant: "alpha" });
    const bravo = viewerFromAuthenticatedClaims({ principal: "outsider", tenant: "bravo" });
    // The test process is not necessarily the ingester identity, so grant the
    // shared group separately for an ACL-only assertion below.
    await client.query(
      "UPDATE documents SET acl_groups = '[\"readers\"]'::jsonb WHERE tenant IN ('alpha', 'bravo') AND id = $1",
      ["confluence:page:12345"],
    );
    const alphaReader = viewerFromAuthenticatedClaims({
      principal: "reader",
      tenant: "alpha",
      groups: ["readers"],
    });
    const bravoReader = viewerFromAuthenticatedClaims({
      principal: "reader",
      tenant: "bravo",
      groups: ["readers"],
    });

    expect((await getDoc(client, alphaReader, "confluence:page:12345"))?.body).toBe(
      "alpha-only runbook",
    );
    expect((await getDoc(client, bravoReader, "confluence:page:12345"))?.body).toBe(
      "bravo-only runbook",
    );
    expect(await getDoc(client, alpha, "confluence:page:12345")).toBeNull();
    expect(await getDoc(client, bravo, "confluence:page:12345")).toBeNull();
    const chunks = await client.query(
      "SELECT tenant, count(*)::int AS n FROM chunks WHERE doc_id = $1 GROUP BY tenant ORDER BY tenant",
      ["confluence:page:12345"],
    );
    expect(chunks.rows).toEqual([
      { tenant: "alpha", n: 1 },
      { tenant: "bravo", n: 1 },
    ]);
  });

  // Regression: the focal-doc probe in expand() negated the WHOLE visibility
  // conjunction, tenant included, so the OTHER tenant's row with the same id
  // satisfied NOT(...) and expand short-circuited to zero edges for a viewer
  // fully entitled to their own copy. getDoc kept working throughout, which is
  // what made it silent. The entity route calls expand() for every jira:issue:*
  // query, so this returned linked: [] on every Jira lookup.
  it("expands a doc whose canonical id also exists in another tenant", async () => {
    for (const t of ["alpha", "bravo"]) {
      await upsertDocument(
        client,
        CanonicalDoc.parse({
          id: "confluence:page:hub",
          tenant: t,
          source: "confluence",
          title: `Hub ${t}`,
          body: `hub body ${t}`,
          aclGroups: ["readers"],
          links: [`confluence:page:leaf-${t}`],
        }),
      );
    }
    const reader = viewerFromAuthenticatedClaims({
      principal: "reader",
      tenant: "alpha",
      groups: ["readers"],
    });
    const out = await expand(client, reader, "confluence:page:hub");
    expect(out.edges.map((e) => e.id)).toEqual(["confluence:page:leaf-alpha"]);
  });

  it("never surfaces another tenant's document through search or the vector arm", async () => {
    const reader = viewerFromAuthenticatedClaims({
      principal: "reader",
      tenant: "alpha",
      groups: ["readers"],
    });
    const res = (await searchDocs(client, reader, "runbook", 10)) as {
      results: Array<{ id: string }>;
    };
    for (const r of res.results) {
      const owner = await client.query(
        "SELECT tenant FROM documents WHERE id = $1 AND tenant = $2",
        [r.id, "alpha"],
      );
      expect(owner.rows).toHaveLength(1); // every hit belongs to the viewer's tenant
    }
    // and the bodies returned are alpha's, never bravo's
    const doc12345 = await getDoc(client, reader, "confluence:page:12345");
    expect(doc12345?.body).toBe("alpha-only runbook");
  });

  // Regression: (doc_id, seq) stopped being unique at migration 0009, so a
  // tenant-blind UPDATE in backfill wrote one tenant's vector onto every
  // same-id chunk in every other tenant.
  it("writes embeddings only to the owning tenant's chunk", async () => {
    const { FakeEmbedder } = await import("../embed/index.js");
    const { backfill } = await import("../embed/backfill.js");
    const emb = new FakeEmbedder(8);
    await backfill(client, emb, {});
    // Vectors now live in chunk_vectors (migration 0020), one row per window —
    // not on chunks.embedding, which backfill() no longer writes.
    const rows = await client.query(
      "SELECT tenant, count(*)::int AS n FROM chunk_vectors" +
        " WHERE doc_id = $1 AND embed_model = $2 GROUP BY tenant ORDER BY tenant",
      ["confluence:page:12345", emb.id],
    );
    expect(rows.rows.map((r: any) => r.n > 0)).toEqual([true, true]);
    // distinct text per tenant must yield distinct vectors, not one overwriting the other
    const vecs = await client.query(
      "SELECT tenant, embedding FROM chunk_vectors WHERE doc_id = $1 ORDER BY tenant",
      ["confluence:page:12345"],
    );
    expect(JSON.stringify(vecs.rows[0].embedding)).not.toBe(JSON.stringify(vecs.rows[1].embedding));
  });

  it("refuses caller-constructed viewer objects at the tool boundary", async () => {
    const result = await callTool(
      "search_docs",
      { query: "runbook" },
      { principal: "forged", tenant: "alpha", groups: ["readers"] },
      client,
    );
    expect(result).toEqual({
      error: "untrusted viewer: construct context from verified authenticated claims",
    });
  });

  it("keeps connector cursors independent per tenant", async () => {
    await setCursor(client, "confluence:space:ENG", "alpha-cursor", "alpha");
    await setCursor(client, "confluence:space:ENG", "bravo-cursor", "bravo");
    expect(await getCursor(client, "confluence:space:ENG", "alpha")).toBe("alpha-cursor");
    expect(await getCursor(client, "confluence:space:ENG", "bravo")).toBe("bravo-cursor");
  });

  it("rejects unauthenticated or tenantless request claims", () => {
    expect(() => viewerFromAuthenticatedClaims({ principal: "reader", groups: [] })).toThrow();
    expect(() => viewerFromAuthenticatedClaims({ tenant: "alpha", groups: [] })).toThrow();
  });
});
