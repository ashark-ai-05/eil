import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import { getDoc, viewerFromAuthenticatedClaims } from "../search.js";
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
