/**
 * Red-team ACL suite — the phase-2 rollout gate, ported with every scenario
 * including the reviewer-found leak regressions. Runs against a dedicated
 * database; skipped when Postgres is unreachable.
 */

import { userInfo } from "node:os";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { connect, migrationFiles } from "../db.js";
import { type Viewer, expand, getDoc, searchDocs } from "../search.js";
import { upsertDocument } from "../store.js";

const ME = userInfo().username;
const OUTSIDER: Viewer = { principal: ME, groups: ["grp-payments"] };
const INSIDER: Viewer = { principal: ME, groups: ["grp-secret"] };

const doc = (id: string, title: string, body: string, acl: string[], links: string[] = []) =>
  CanonicalDoc.parse({ id, source: "confluence", title, body, aclGroups: acl, links });

let client: pg.Client;
let available = true;
try {
  const probe = await connect("postgres");
  await probe.end();
} catch {
  available = false;
}

async function admin(sqlText: string): Promise<void> {
  const a = await connect("postgres");
  try {
    await a.query(sqlText);
  } finally {
    await a.end();
  }
}

beforeAll(async () => {
  try {
    await admin("DROP DATABASE IF EXISTS eil_ts_acl");
    await admin("CREATE DATABASE eil_ts_acl");
  } catch {
    available = false;
    return;
  }
  client = await connect("eil_ts_acl");
  const dbCheck = await client.query("SELECT current_database() AS db");
  if (dbCheck.rows[0].db !== "eil_ts_acl") throw new Error(`wrong database: ${dbCheck.rows[0].db}`);
  for (const { sql } of migrationFiles()) await client.query(sql);
  await upsertDocument(
    client,
    doc("confluence:page:open", "Public Runbook", "zebra deployment guide for everyone", []),
  );
  await upsertDocument(
    client,
    doc(
      "confluence:page:secret",
      "Merger Plans",
      "zebra deployment guide for insiders only",
      ["grp-secret"],
      ["jira:issue:SEC-1"],
    ),
  );
  await upsertDocument(
    client,
    doc("jira:issue:SEC-1", "SEC-1 secret ticket", "restricted zebra work", ["grp-secret"]),
  );
  await client.query(
    "UPDATE documents SET ingested_by = 'mallory-ingester'" +
      " WHERE id IN ('confluence:page:secret', 'jira:issue:SEC-1')",
  );
});

afterAll(async () => {
  if (!available) return;
  await client.end();
  await admin("DROP DATABASE eil_ts_acl WITH (FORCE)");
});

describe.skipIf(!available)("ACL red-team", () => {
  it("restricted doc never surfaces in search", async () => {
    const result: any = await searchDocs(client, OUTSIDER, "zebra deployment guide");
    const ids = result.results.map((r: any) => r.id);
    expect(ids).toContain("confluence:page:open");
    expect(ids).not.toContain("confluence:page:secret");
  });

  it("restricted doc not fetchable", async () => {
    expect(await getDoc(client, OUTSIDER, "confluence:page:secret")).toBeNull();
  });

  it("entity route respects ACL and returns empty linked", async () => {
    const result: any = await searchDocs(client, OUTSIDER, "SEC-1");
    expect(result.entity).toBeNull();
    expect(result.linked).toEqual([]);
  });

  it("expanding a restricted doc leaks nothing, not even dangling edges", async () => {
    await upsertDocument(
      client,
      doc(
        "confluence:page:secret-linky",
        "Secret Linky",
        "restricted content",
        ["grp-secret"],
        ["jira:issue:HID-9"],
      ),
    );
    await client.query(
      "UPDATE documents SET ingested_by = 'mallory-ingester' WHERE id = 'confluence:page:secret-linky'",
    );
    const outsider = await expand(client, OUTSIDER, "confluence:page:secret-linky");
    expect(outsider.edges).toEqual([]); // not even jira:issue:HID-9
    const insider = await expand(client, INSIDER, "confluence:page:secret-linky");
    expect(insider.edges.some((e) => e.id === "jira:issue:HID-9")).toBe(true);
  });

  it("expand drops edges to restricted docs from the readable side", async () => {
    await upsertDocument(
      client,
      doc("confluence:page:linker", "Linker", "mentions SEC-1", [], ["jira:issue:SEC-1"]),
    );
    const result = await expand(client, OUTSIDER, "confluence:page:linker");
    expect(result.edges.every((e) => e.id !== "jira:issue:SEC-1")).toBe(true);
  });

  it("group membership grants access", async () => {
    expect(await getDoc(client, INSIDER, "confluence:page:secret")).not.toBeNull();
    const result: any = await searchDocs(client, INSIDER, "zebra deployment guide");
    expect(result.results.map((r: any) => r.id)).toContain("confluence:page:secret");
  });

  it("ingester always sees own documents", async () => {
    expect(
      await getDoc(client, { principal: ME, groups: [] }, "confluence:page:open"),
    ).not.toBeNull();
  });

  it("empty acl is fail-closed for others", async () => {
    const stranger: Viewer = { principal: "someone-else", groups: ["grp-payments"] };
    expect(await getDoc(client, stranger, "confluence:page:open")).toBeNull();
  });

  it("re-ingest heals empty ingested_by", async () => {
    const legacy = doc("confluence:page:legacy", "Legacy", "legacy content here", []);
    await upsertDocument(client, legacy);
    await client.query("UPDATE documents SET ingested_by = '' WHERE id = 'confluence:page:legacy'");
    expect(
      await getDoc(client, { principal: ME, groups: [] }, "confluence:page:legacy"),
    ).toBeNull();
    expect(await upsertDocument(client, legacy)).toBe(true); // gate bypassed, not a no-op
    expect(
      await getDoc(client, { principal: ME, groups: [] }, "confluence:page:legacy"),
    ).not.toBeNull();
  });

  it("deleting a document cascades its link edges", async () => {
    await upsertDocument(
      client,
      doc("confluence:page:doomed", "Doomed", "references DOOM-1", [], ["jira:issue:DOOM-1"]),
    );
    const before = await client.query(
      "SELECT count(*)::int AS n FROM links WHERE src_id = 'confluence:page:doomed'",
    );
    expect(before.rows[0].n).toBe(1);
    await client.query("DELETE FROM documents WHERE id = 'confluence:page:doomed'");
    const after = await client.query(
      "SELECT count(*)::int AS n FROM links WHERE src_id = 'confluence:page:doomed'",
    );
    expect(after.rows[0].n).toBe(0);
  });

  it("out-edges not starved by in-edges, truncation reported", async () => {
    await upsertDocument(
      client,
      doc("confluence:page:hub", "Hub", "the hub", [], ["jira:issue:OUT-1"]),
    );
    for (let n = 0; n < 3; n++) {
      await upsertDocument(
        client,
        doc(`confluence:page:spoke${n}`, `Spoke ${n}`, "spoke", [], ["confluence:page:hub"]),
      );
    }
    const limited = await expand(client, { principal: ME, groups: [] }, "confluence:page:hub", 2);
    expect(limited.edges.some((e) => e.direction === "out")).toBe(true);
    expect(limited.truncated).toBe(true);
    const full = await expand(client, { principal: ME, groups: [] }, "confluence:page:hub", 50);
    expect(full.truncated).toBe(false);
    expect(full.edges.filter((e) => e.direction === "in")).toHaveLength(3);
  });
});
