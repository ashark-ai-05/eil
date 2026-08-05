/**
 * End-to-end proof that a relationship type survives the whole path:
 * Jira issuelinks -> normalize -> upsertDocument -> links.rel -> expand().
 *
 * The unit tests in links.test.ts prove normalize() carries `rel`, which is
 * necessary but not sufficient: the type was previously lost in `store.ts`,
 * one statement before persistence, so a model-only test would have passed
 * against the bug this file exists to close.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db.js";
import { normalize as normalizeJira } from "../ingest/jira.js";
import { type Viewer, expand, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

describe("link types reach expand()", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  // Group-stamped rather than owner-stamped: `ingested_by` is whatever OS user
  // ran the process, which is not something a test should depend on, and a
  // group grant is the shape a real multi-user read will take anyway.
  const GROUP = "eng";
  const reader = (): Viewer =>
    viewerFromAuthenticatedClaims({ principal: "reader", tenant: "default", groups: [GROUP] });

  const ingest = async (issue: Parameters<typeof normalizeJira>[0]) => {
    await upsertDocument(db, { ...normalizeJira(issue), aclGroups: [GROUP] });
  };

  it("distinguishes a blocker from a duplicate on the same document", async () => {
    await ingest({
      key: "PAY-100",
      url: null,
      fields: {
        summary: "Retry storm",
        project: "PAY",
        description: "Investigating.",
        parent: "PAY-1",
        issue_links: [
          { type: "blocks", key: "PAY-42" },
          { type: "duplicates", key: "PAY-43" },
          { type: "is blocked by", key: "PAY-44" },
        ],
      },
    } as Parameters<typeof normalizeJira>[0]);

    const { edges } = await expand(db, reader(), "jira:issue:PAY-100");
    const relOf = (id: string) => edges.find((e) => e.id === id && e.direction === "out")?.rel;

    expect(relOf("jira:issue:PAY-42")).toBe("blocks");
    expect(relOf("jira:issue:PAY-43")).toBe("duplicates");
    expect(relOf("jira:issue:PAY-44")).toBe("is-blocked-by");
    expect(relOf("jira:issue:PAY-1")).toBe("parent");
  });

  it("stores one row per relationship, not one per (id, rel) pair", async () => {
    // The same issue is both a declared blocker and named in the description.
    // `rel` is part of the links primary key, so a naive dedup on the pair
    // would persist two rows describing one relationship.
    await ingest({
      key: "PAY-200",
      url: null,
      fields: {
        summary: "Duplicate edge check",
        project: "PAY",
        description: "Blocked by PAY-42. See PAY-42.",
        issue_links: [{ type: "blocks", key: "PAY-42" }],
      },
    } as Parameters<typeof normalizeJira>[0]);

    const rows = await db.query(
      "SELECT rel FROM links WHERE tenant = 'default' AND src_id = $1 AND dst_id = $2",
      ["jira:issue:PAY-200", "jira:issue:PAY-42"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].rel).toBe("blocks");
  });

  it("re-ingest replaces link types rather than accumulating them", async () => {
    const issue = (type: string) =>
      ({
        key: "PAY-300",
        url: null,
        fields: {
          summary: "Changing relationship",
          project: "PAY",
          // Body must differ or the content hash gate skips the write entirely.
          description: `Relationship is now ${type}.`,
          issue_links: [{ type, key: "PAY-42" }],
        },
      }) as Parameters<typeof normalizeJira>[0];

    await ingest(issue("blocks"));
    await ingest(issue("duplicates"));

    const rows = await db.query(
      "SELECT rel FROM links WHERE tenant = 'default' AND src_id = $1 AND dst_id = $2",
      ["jira:issue:PAY-300", "jira:issue:PAY-42"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].rel).toBe("duplicates");
  });
});
