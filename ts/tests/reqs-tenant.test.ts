/**
 * Tenant isolation on the requirements path.
 *
 * Both defects here were *reasoned* code, not careless code. The author lookup
 * carried a comment explaining why it needed no ACL check — correct about ACL,
 * silently wrong about tenancy, because the authorisation it inherited was made
 * against (viewer.tenant, docId) and the query asked for (any tenant, docId).
 *
 * An authorisation decision only covers the key it was made against. That is
 * the invariant these tests pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db.js";
import { normalize as normalizeJira } from "../ingest/jira.js";
import {
  detectCorpusMode,
  detectCorpusModeAcrossAllTenants,
  readWorkItem,
} from "../reqs/elaborate.js";
import { type Viewer, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

describe("detectCorpusMode is tenant-scoped", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  const seed = (tenant: string, id: string, url: string) =>
    upsertDocument(db, {
      ...normalizeJira(
        {
          key: id,
          url,
          fields: { summary: "s", project: "PAY", description: "d" },
        } as never,
        tenant,
      ),
      aclGroups: ["eng"],
    });

  it("a neighbour's synthetic corpus cannot mark this tenant's run as fixtures", async () => {
    await seed("real", "PAY-1", "https://jira.corp.internal/browse/PAY-1");
    await seed("demo", "PAY-2", "https://jira.example.com/browse/PAY-2");

    // Unscoped, the mixed catalog is neither all-synthetic nor empty, so the
    // demo tenant's seed data is what decides the real tenant's narration.
    expect(await detectCorpusMode(db, "real")).toBe("live");
  });

  it("a neighbour's real corpus cannot bless this tenant's synthetic run as live", async () => {
    await seed("real", "PAY-1", "https://jira.corp.internal/browse/PAY-1");
    await seed("demo", "PAY-2", "https://jira.example.com/browse/PAY-2");

    // The under-claiming direction is the safe one: a synthetic run narrated as
    // live is the failure that matters, never the reverse.
    expect(await detectCorpusMode(db, "demo")).toBe("fixtures");
  });

  it("an empty tenant reports fixtures even when the catalog is busy", async () => {
    await seed("real", "PAY-1", "https://jira.corp.internal/browse/PAY-1");
    expect(await detectCorpusMode(db, "empty-tenant")).toBe("fixtures");
  });

  it("the whole-catalog form is reachable only by naming it explicitly", async () => {
    await seed("real", "PAY-1", "https://jira.corp.internal/browse/PAY-1");
    await seed("demo", "PAY-2", "https://jira.example.com/browse/PAY-2");
    // A separate NAME, not an omitted argument. When tenant was optional the
    // cross-tenant query was what you got by forgetting to think about it.
    expect(await detectCorpusModeAcrossAllTenants(db)).toBe("live");
  });
});

describe("the requirements author lookup is bound to the viewer's tenant", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("selects THIS tenant's author when the same canonical id exists in two", async () => {
    // The same work item id in two tenants is not a collision, it is the
    // documented shape of PRIMARY KEY (tenant, id).
    for (const [tenant, reporter] of [
      ["alpha", "alice"],
      ["beta", "bob"],
    ] as const) {
      await upsertDocument(db, {
        ...normalizeJira(
          {
            key: "PAY-500",
            url: null,
            fields: { summary: "Shared id", project: "PAY", description: "d", reporter },
          } as never,
          tenant,
        ),
        aclGroups: ["eng"],
      });
    }

    // Precondition: the ambiguity the fix defends against really exists. The
    // unscoped query — what the code used to run — matches BOTH rows, so
    // rows[0] is whichever the planner happens to return.
    const { rows } = await db.query("SELECT author FROM documents WHERE id = $1", [
      "jira:issue:PAY-500",
    ]);
    expect(rows.length).toBe(2);

    // Exercise the real code path, not a hand-written query beside it. An
    // earlier draft of this test asserted against its own SQL and passed
    // identically before and after the fix — proving the database's shape and
    // nothing about readWorkItem.
    const viewer = (tenant: string): Viewer =>
      viewerFromAuthenticatedClaims({ principal: "reader", tenant, groups: ["eng"] });

    const alpha = await readWorkItem(db, viewer("alpha"), "jira:issue:PAY-500");
    const beta = await readWorkItem(db, viewer("beta"), "jira:issue:PAY-500");

    expect(alpha?.author).toBe("alice");
    expect(beta?.author).toBe("bob");
  });
});

describe("elaborate refuses to guess whose catalog it is reading", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await db.end();
  });

  it("throws when a client is supplied without a viewer and no explicit corpusMode", async () => {
    // The fall-through this replaces was silent: `deps.viewer?.tenant` became
    // undefined, the tenant argument was optional, and the query widened to the
    // whole catalog — stamping a verdict derived from every organisation's data
    // into one organisation's artefact. Refusing is the only safe reading.
    const { elaborate } = await import("../reqs/elaborate.js");
    await expect(
      elaborate("PTR-401", {
        client: db,
        title: "Injected title",
        brief: "Injected brief",
      } as never),
    ).rejects.toThrow(/deps\.viewer/);
  });

  it("accepts a client without a viewer when corpusMode is stated outright", async () => {
    // Not a blanket ban: an explicit corpusMode means the caller has already
    // answered the question, so there is nothing to derive and nothing to guess.
    //
    // Asserted by inspecting the message rather than with `rejects.not.toThrow`,
    // which passes whenever ANY other rejection occurs and would therefore hide
    // the difference between "got past the guard" and "failed somewhere else".
    // elaborate() legitimately fails later here without an LLM configured; what
    // matters is that it is no longer the viewer guard stopping it.
    const { elaborate } = await import("../reqs/elaborate.js");
    let message = "";
    try {
      await elaborate("PTR-401", {
        client: db,
        title: "Injected title",
        brief: "Injected brief",
        corpusMode: "fixtures",
      } as never);
    } catch (err) {
      message = String((err as Error)?.message ?? err);
    }
    expect(message).not.toMatch(/deps\.viewer/);
  });
});
