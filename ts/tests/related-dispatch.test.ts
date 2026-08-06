/**
 * Related-state acquisition must reach BOTH dispatch paths, and the code
 * hard-delete must not be able to destroy evidence.
 *
 * `ingestScope` has two entry points: the cursor-driven sweep and the explicit
 * named-items branch behind `--page` / `--issue`. The explicit branch built
 * documents on its own and never called `acquireRelated`, so `--attachments`
 * combined with `--page` reported a clean run having acquired nothing. A flag
 * that silently does nothing on one of its two entry points is worse than an
 * unimplemented one, because the run LOOKS like coverage.
 */
import { describe, expect, it } from "vitest";
import { publishArtifactVersion } from "../artifacts.js";
import type { CanonicalDoc } from "../contracts/models.js";
import { type Db, withTransaction } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { type TimestampSource, confluenceSpec, ingestScope, jiraSpec } from "../ingest/registry.js";
import { hardDeleteDocument } from "../purge.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

interface Raw {
  id: string;
}

const doc = (id: string): CanonicalDoc =>
  normalizeConfluence({
    id,
    title: `Page ${id}`,
    url: null,
    author: null,
    updated: "2026-03-01T00:00:00Z",
    created: "2026-03-01T00:00:00Z",
    ancestors: ["ENG"],
    acl_groups: ["eng"],
    labels: [],
    body: "<p>body</p>",
  } as never);

/** A spec that records which raw items its related-hook was offered. */
function probeSpec(): { spec: TimestampSource<Raw>; acquired: string[] } {
  const acquired: string[] = [];
  const spec: TimestampSource<Raw> = {
    name: "confluence",
    description: "probe",
    cursor: "timestamp",
    requiresEnv: [],
    makeClient: async () => ({}),
    normalize: (raw) => doc(raw.id),
    updatedSince: async function* () {
      yield { id: "SWEPT" };
    },
    explicit: {
      scopeKind: "page",
      idsOf: (scope) => (scope as { ids: string[] }).ids,
      fetch: async function* (_client, id) {
        yield { id };
      },
    },
    listIds: async () => [],
    acquireRelated: async (_client, raw) => {
      acquired.push(raw.id);
      return { debt: 0, persist: async () => {} };
    },
  };
  return { spec, acquired };
}

describe("acquireRelated is reached from every dispatch path", () => {
  it("runs on the cursor-driven sweep", async () => {
    const db = await openTestDb();
    const { spec, acquired } = probeSpec();
    await ingestScope(spec, {}, { kind: "space", keys: ["ENG"] } as never, "default", {
      tenant: "default",
      attachments: true,
    });
    expect(acquired).toEqual(["SWEPT"]);
    await db.end();
  });

  it("runs on the explicit named-items branch too", async () => {
    // The regression. Before the two paths shared one raw->doc->item step, this
    // list came back empty while the run reported success.
    const db = await openTestDb();
    const { spec, acquired } = probeSpec();
    await ingestScope(spec, {}, { kind: "page", ids: ["P1", "P2"] } as never, "default", {
      tenant: "default",
      attachments: true,
    });
    expect(acquired).toEqual(["P1", "P2"]);
    await db.end();
  });

  it("both production Atlassian specs declare the hook and an explicit branch", async () => {
    // Structural, and the reason is that the two tests above use a probe spec.
    // If either production spec lost `acquireRelated`, those would still pass
    // and `--attachments` would do nothing in production.
    for (const spec of [confluenceSpec, jiraSpec]) {
      expect(typeof spec.acquireRelated).toBe("function");
      expect(spec.explicit).toBeDefined();
    }
  });
});

describe("the repository-code hard delete cannot destroy evidence", () => {
  it("deletes a document that owns nothing", async () => {
    const db: Db = await openTestDb();
    await upsertDocument(db, doc("A"));
    await hardDeleteDocument(db, "default", "confluence:page:A");
    const left = await db.query("SELECT count(*)::int AS n FROM documents");
    expect(left.rows[0].n).toBe(0);
    await db.end();
  });

  it("refuses by name when a document still owns artifacts", async () => {
    // Code documents carry no attachments today, so this is a contract rather
    // than a live hazard — which is exactly why it is pinned. The day one does,
    // the failure should name the invariant instead of surfacing as a raw
    // constraint violation from inside a reconcile loop.
    const db: Db = await openTestDb();
    await upsertDocument(db, doc("A"));
    await withTransaction(db, (tx) =>
      publishArtifactVersion(tx, {
        tenant: "default",
        source: "confluence",
        nativeId: "att1",
        revision: "1",
        docId: "confluence:page:A",
        mediaType: "application/pdf",
        filename: "att1.pdf",
        bytes: Buffer.from("%PDF evidence"),
      }),
    );

    await expect(hardDeleteDocument(db, "default", "confluence:page:A")).rejects.toThrow(
      /refusing to hard-delete .*1 artifact version/,
    );
    const left = await db.query("SELECT count(*)::int AS n FROM documents");
    expect(left.rows[0].n).toBe(1);
    await db.end();
  });
});
