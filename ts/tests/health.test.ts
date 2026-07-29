/**
 * The alerting half of "the system's self-reporting is biased toward healthy".
 *
 * Step 0 fixed the recording side. These assert the reporting side: a connector
 * that fails must LOOK failed, and a system with no data must not read as fine.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import { setCursor } from "../store.js";

let client: Db;
let dir: string;
let saved: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eil-health-"));
  saved = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  client = await connect();
  await migrate(client);
});
afterAll(async () => {
  await client.end();
  if (saved === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = saved;
  rmSync(dir, { recursive: true, force: true });
});

const health = async (source: string) =>
  (
    await client.query(
      "SELECT * FROM metrics.vw_connector_health WHERE source = $1 AND tenant = 'default'",
      [source],
    )
  ).rows[0];

describe("the stale-cursor tripwire is no longer defeated by the rot it detects", () => {
  it("a FAILED run holds the cursor but does NOT reset the freshness clock", async () => {
    await setCursor(client, "confluence:a", "t1", "default", { succeeded: true });
    const fresh = await health("confluence:a");
    expect(fresh.last_success_at).not.toBeNull();

    // Age the success clock, then simulate an hourly run that fails everything.
    await client.query(
      "UPDATE sync_cursors SET last_success_at = now() - interval '30 hours' WHERE source = 'confluence:a'",
    );
    await setCursor(client, "confluence:a", "t1", "default", {
      succeeded: false,
      error: "GET /rest/api/content -> 429",
    });

    const after = await health("confluence:a");
    // updated_at moved (we DID write the row) but the alert reads age_hours,
    // which is derived from last_success_at and must still show the rot.
    expect(Number(after.age_hours)).toBeGreaterThan(24);
    expect(after.consecutive_failures).toBe(1);
    expect(after.last_error).toContain("429");
  });

  it("counts consecutive failures and clears them on a real success", async () => {
    await setCursor(client, "confluence:b", "t1", "default", { succeeded: false, error: "boom" });
    await setCursor(client, "confluence:b", "t1", "default", { succeeded: false, error: "boom" });
    expect((await health("confluence:b")).consecutive_failures).toBe(2);
    await setCursor(client, "confluence:b", "t2", "default", { succeeded: true });
    const ok = await health("confluence:b");
    expect(ok.consecutive_failures).toBe(0);
    expect(Number(ok.age_hours)).toBeLessThan(1);
  });

  it("distinguishes tenants, which the old view collapsed into duplicate rows", async () => {
    await setCursor(client, "confluence:c", "x", "alpha", { succeeded: true });
    await setCursor(client, "confluence:c", "y", "bravo", { succeeded: true });
    const rows = await client.query(
      "SELECT tenant, cursor FROM metrics.vw_connector_health WHERE source = 'confluence:c' ORDER BY tenant",
    );
    expect(rows.rows.map((r: any) => [r.tenant, r.cursor])).toEqual([
      ["alpha", "x"],
      ["bravo", "y"],
    ]);
  });
});

describe("the alert file can actually deliver", () => {
  const cfg = readFileSync(
    new URL("../../observability/grafana/provisioning/alerting/eil-alerts.yaml", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .filter((l) => !l.trim().startsWith("#")) // prose describing the fix is not config
    .join("\n");

  it("declares contact points and a notification policy", () => {
    // Rules alone are inert in Grafana unified alerting: without BOTH of these,
    // every rule fires into a void and the whole file is decorative.
    expect(cfg).toContain("contactPoints:");
    expect(cfg).toContain("policies:");
    expect(cfg).toContain("receiver: eil-default");
  });

  it("treats absent data as a problem, not as health", () => {
    // `noDataState: OK` inverted the worst case — a connector that has NEVER
    // synced returns no rows and was reported healthy.
    expect(cfg).not.toContain("noDataState: OK");
    expect(cfg.split("noDataState: NoData").length - 1).toBe(3);
  });

  it("does not default a missing staleness reading to zero hours", () => {
    expect(cfg).not.toContain("max(age_hours), 0");
  });
});

describe("retention", () => {
  it("keeps a document's current revision however old the history is", async () => {
    // Pruning history must never orphan a document's present state.
    await client.query(
      "INSERT INTO documents (id, tenant, source, title, quality_tier, content_hash, body, ingested_by, revision)" +
        " VALUES ('confluence:page:old', 'default', 'confluence', 'Old', 'authored', 'h', 'b', 'me', 2)",
    );
    for (const [rev, age] of [
      [1, "400 days"],
      [2, "400 days"],
    ] as const) {
      await client.query(
        `INSERT INTO document_revisions (tenant, doc_id, revision, source, content_hash, acl_snapshot, acl_version, captured_at) VALUES ('default', 'confluence:page:old', $1, 'confluence', 'h', '[]', 'v', now() - interval '${age}')`,
        [rev],
      );
    }
    await client.query(
      "DELETE FROM document_revisions r WHERE r.captured_at < now() - interval '90 days'" +
        " AND EXISTS (SELECT 1 FROM documents d WHERE d.tenant = r.tenant AND d.id = r.doc_id" +
        "             AND d.revision > r.revision)",
    );
    const left = await client.query(
      "SELECT revision FROM document_revisions WHERE doc_id = 'confluence:page:old' ORDER BY revision",
    );
    expect(left.rows.map((r: any) => Number(r.revision))).toEqual([2]); // current kept
  });

  it("purges quarantine only once it has actually expired", async () => {
    for (const [id, until] of [
      ["confluence:page:q-live", "now() + interval '5 days'"],
      ["confluence:page:q-dead", "now() - interval '1 day'"],
    ] as const) {
      await client.query(
        `INSERT INTO documents (id, tenant, source, title, quality_tier, content_hash, body, ingested_by, tombstoned_at, quarantine_until) VALUES ($1, 'default', 'confluence', 't', 'authored', 'h', 'b', 'me', now(), ${until})`,
        [id],
      );
    }
    await client.query(
      "DELETE FROM documents WHERE tombstoned_at IS NOT NULL" +
        " AND quarantine_until IS NOT NULL AND quarantine_until < now()",
    );
    const left = await client.query(
      "SELECT id FROM documents WHERE id LIKE 'confluence:page:q-%' ORDER BY id",
    );
    expect(left.rows.map((r: any) => r.id)).toEqual(["confluence:page:q-live"]);
  });
});
