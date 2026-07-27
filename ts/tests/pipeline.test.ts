import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfluencePage } from "../ingest/confluence.js";
import type { JiraIssue } from "../ingest/jira.js";
import { ingestConfluenceScope, ingestJiraScope } from "../ingest/pipeline.js";

// Drive the orchestration against a real (PGlite) DB and a fake connector,
// asserting the SCOPED cursor advances and the global one does not.
const dir = mkdtempSync(join(tmpdir(), "eil-pipeline-"));

beforeAll(async () => {
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  const { connect, migrate } = await import("../db.js");
  const c = await connect();
  await migrate(c);
  await c.end();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const page = (id: string, updated: string): ConfluencePage => ({
  id,
  title: `p${id}`,
  url: null,
  author: "a",
  updated,
  created: null,
  ancestors: ["ENG"],
  acl_groups: [],
  body: `body ${id} ${updated}`,
});

const fakeConf = {
  async *updatedSince(_cursor: string | null, _scope?: string) {
    yield page("100", "2026-06-05T00:00:00+00:00");
  },
  async getPage(id: string) {
    return page(id, "2026-06-06T00:00:00+00:00");
  },
  async *descendants(_id: string) {
    yield page("101", "2026-06-06T00:00:00+00:00");
  },
};

describe("ingestConfluenceScope", () => {
  it("advances the SCOPED cursor, not the global one", async () => {
    await ingestConfluenceScope(fakeConf, { kind: "space", key: "ENG" }, "default");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const c = await connect();
    try {
      expect(await getCursor(c, "confluence:space:ENG")).toBe("2026-06-05T00:00:00+00:00");
      expect(await getCursor(c, "confluence")).toBeNull();
    } finally {
      await c.end();
    }
  });

  it("explicit pages write no cursor and can include descendants", async () => {
    await ingestConfluenceScope(
      fakeConf,
      { kind: "pages", ids: ["100"], withDescendants: true },
      "default",
    );
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const c = await connect();
    try {
      // no cursor key exists for explicit pages
      expect(await getCursor(c, "confluence")).toBeNull();
      // both the page and its descendant were upserted
      const n = await c.query("SELECT count(*)::int AS n FROM documents WHERE id IN ($1,$2)", [
        "confluence:page:100",
        "confluence:page:101",
      ]);
      expect(n.rows[0].n).toBe(2);
    } finally {
      await c.end();
    }
  });
});

const issue = (key: string, updated: string): JiraIssue => ({
  key,
  url: null,
  fields: {
    summary: `Issue ${key}`,
    status: "Open",
    issuetype: "Task",
    project: "PAY",
    reporter: "reporter@example.com",
    created: "2026-06-05T00:00:00+00:00",
    updated,
    description: `body ${key} ${updated}`,
    comments: [],
    acl_groups: [],
  },
});

const fakeJira = {
  async *updatedSince(_cursor: string | null, _scope?: string) {
    yield issue("PAY-100", "2026-06-05T00:00:00+00:00");
  },
  async getIssue(key: string) {
    return issue(key, "2026-06-06T00:00:00+00:00");
  },
};

describe("ingestJiraScope", () => {
  it("advances the SCOPED cursor, not the global one", async () => {
    await ingestJiraScope(fakeJira, { kind: "project", key: "PAY" }, "default");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const c = await connect();
    try {
      expect(await getCursor(c, "jira:project:PAY")).toBe("2026-06-05T00:00:00+00:00");
      expect(await getCursor(c, "jira")).toBeNull();
    } finally {
      await c.end();
    }
  });

  it("explicit issues write no cursor and can be upserted", async () => {
    await ingestJiraScope(fakeJira, { kind: "issues", keys: ["PAY-1"] }, "default");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const c = await connect();
    try {
      // no cursor key exists for explicit issues
      expect(await getCursor(c, "jira")).toBeNull();
      // the issue was upserted
      const n = await c.query("SELECT count(*)::int AS n FROM documents WHERE id = $1", [
        "jira:issue:PAY-1",
      ]);
      expect(n.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });
});
