import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
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

// Acceptance criterion for step 1: "a 429 on page 40 of 200 does not lose pages
// 1-39 and the run resumes". The connector fails deterministically at a fixed
// offset, which is the shape that produced the livelock — every run re-fetched
// the same prefix, hit the same wall, and advanced nothing.
describe("a mid-listing failure keeps the progress already earned", () => {
  const FAIL_AT = 40;
  const TOTAL = 200;
  // Real timestamps: a hand-rolled `00:${i}:00` emits an invalid 00:100:00 past
  // i=59 AND sorts lexically wrong ("100" < "99"), which silently breaks the
  // max-cursor logic under test rather than the code.
  const BASE = Date.UTC(2026, 5, 5, 0, 0, 0);
  const stamp = (i: number) => new Date(BASE + i * 60_000).toISOString();

  async function* pagedThenFails(from: number) {
    for (let i = from; i < TOTAL; i++) {
      if (i === FAIL_AT) throw new Error("GET /rest/api/content -> 429");
      yield CanonicalDoc.parse({
        id: `confluence:page:${9000 + i}`,
        source: "confluence",
        title: `p${i}`,
        body: `body ${i}`,
        updatedAt: stamp(i),
        aclGroups: [],
      });
    }
  }

  it("commits the cursor at the last document that landed, then rethrows", async () => {
    const { ingestDocs } = await import("../ingest/pipeline.js");
    const { getCursor } = await import("../store.js");
    const { connect } = await import("../db.js");

    await expect(
      ingestDocs("confluence:resume-test", pagedThenFails(0), (d) => d.updatedAt ?? null),
    ).rejects.toThrow("429");

    const c = await connect();
    try {
      // pages 0..39 landed and the cursor advanced with them
      const stored = await getCursor(c, "confluence:resume-test");
      expect(stored).toBe(stamp(FAIL_AT - 1));
      const n = await c.query(
        "SELECT count(*)::int AS n FROM documents WHERE id LIKE 'confluence:page:9%'",
      );
      expect(n.rows[0].n).toBe(FAIL_AT);
    } finally {
      await c.end();
    }
  });

  it("resumes from that cursor rather than restarting the scan", async () => {
    const { ingestDocs } = await import("../ingest/pipeline.js");
    const { getCursor } = await import("../store.js");
    const { connect } = await import("../db.js");

    // second run: the upstream blip is over, so it starts where it stopped
    async function* rest() {
      for (let i = FAIL_AT; i < TOTAL; i++) {
        yield CanonicalDoc.parse({
          id: `confluence:page:${9000 + i}`,
          source: "confluence",
          title: `p${i}`,
          body: `body ${i}`,
          updatedAt: stamp(i),
          aclGroups: [],
        });
      }
    }
    await ingestDocs("confluence:resume-test", rest(), (d) => d.updatedAt ?? null);

    const c = await connect();
    try {
      expect(await getCursor(c, "confluence:resume-test")).toBe(stamp(TOTAL - 1));
      const n = await c.query(
        "SELECT count(*)::int AS n FROM documents WHERE id LIKE 'confluence:page:9%'",
      );
      expect(n.rows[0].n).toBe(TOTAL);
    } finally {
      await c.end();
    }
  });
});
