/**
 * The two-phase saving, measured.
 *
 * This number goes in front of executives, so the thing worth testing is not
 * that it is large — it is that it is DERIVED. A figure that came out looking
 * good because of a bug would be indistinguishable on stage from one that came
 * out looking good because the architecture works.
 *
 * So: the saving has to scale with document size, collapse when the agent opens
 * everything, and count only documents the caller was allowed to see.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureContextCost } from "../contextcost.js";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import type { Viewer } from "../search.js";
import { upsertDocument } from "../store.js";

const ME = userInfo().username;
const VIEWER: Viewer = { principal: ME, groups: [], tenant: "default" };
const OUTSIDER: Viewer = { principal: "someone.else", groups: [], tenant: "default" };

let dataDir: string;
let client: Db;
let savedUrl: string | undefined;

/** Long enough that returning it whole is visibly different from a snippet. */
const longBody = (topic: string, paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, i) =>
    [
      `## Section ${i + 1}`,
      "",
      `The ${topic} process is reviewed here in detail. Every consideration is set`,
      "out at length so that a reader who was not present can follow the reasoning",
      "without asking anyone, which is the whole point of writing it down. This is",
      `paragraph ${i + 1} of the ${topic} discussion.`,
    ].join("\n"),
  ).join("\n\n");

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "eil-ctxcost-"));
  savedUrl = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
  client = await connect();
  await migrate(client);

  for (let i = 1; i <= 5; i++) {
    await upsertDocument(
      client,
      CanonicalDoc.parse({
        id: `confluence:page:${i}`,
        source: "confluence",
        title: `Settlement runbook ${i}`,
        body: longBody("settlement", 12),
        aclGroups: [],
        links: [],
      }),
    );
  }
  // Restricted, and it matches the same query — so an ACL leak would inflate
  // the pass-through figure and make the saving look bigger than it is.
  await upsertDocument(
    client,
    CanonicalDoc.parse({
      id: "confluence:page:secret",
      source: "confluence",
      title: "Settlement limits, restricted",
      body: longBody("settlement", 12),
      aclGroups: ["grp-locked"],
      links: [],
    }),
  );
});

afterAll(async () => {
  await client?.end();
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

const measure = (viewer: Viewer, fetched = 1, limit = 8) =>
  measureContextCost(client, viewer, "settlement runbook", limit, fetched);

describe("context cost", () => {
  it("costs less to search then fetch than to send every match", async () => {
    const r = await measure(VIEWER);
    expect(r.matched).toBeGreaterThan(1);
    expect(r.passthroughChars).toBeGreaterThan(r.twoPhaseChars);
    expect(r.ratio).not.toBeNull();
    expect(r.ratio!).toBeGreaterThan(1);
  });

  it("reports a per-match cost that does not move with the match count", async () => {
    // The headline ratio climbs as more documents match, because the one
    // document the agent opens is a fixed cost that amortises. The per-match
    // pair is the figure that survives being quoted about someone else's
    // corpus, so it must be stable across limits on the same query.
    const few = await measure(VIEWER, 1, 3);
    const many = await measure(VIEWER, 1, 8);
    expect(many.matched).toBeGreaterThan(few.matched);
    expect(many.ratio!).toBeGreaterThan(few.ratio!);

    const drift = Math.abs(many.passthroughPerDoc! - few.passthroughPerDoc!);
    expect(drift / few.passthroughPerDoc!).toBeLessThan(0.25);
    expect(few.passthroughPerDoc!).toBeGreaterThan(few.snippetPerDoc! * 2);
  });

  it("splits the two-phase figure into the search and the fetch", async () => {
    const r = await measure(VIEWER);
    expect(r.phase1Chars).toBeGreaterThan(0);
    expect(r.phase2Chars).toBeGreaterThan(0);
    expect(r.twoPhaseChars).toBe(r.phase1Chars + r.phase2Chars);
  });

  it("loses its advantage when the agent opens everything", async () => {
    // The honest limit of the argument: two-phase wins because the agent is
    // selective. If it opens every match, there is nothing left to save, and
    // the measurement must show that rather than hide it.
    const selective = await measure(VIEWER, 1);
    const greedy = await measure(VIEWER, 99);
    expect(greedy.twoPhaseChars).toBeGreaterThan(selective.twoPhaseChars);
    expect(greedy.ratio!).toBeLessThan(selective.ratio!);
    expect(greedy.ratio!).toBeLessThan(1.5);
  });

  it("counts only what the caller may see", async () => {
    // The restricted page matches the query. It must be absent from both
    // figures for the outsider, so the saving cannot be inflated by a document
    // that would never have been sent in the first place.
    const insider = await measure(VIEWER);
    const outsider = await measure(OUTSIDER);
    expect(outsider.matched).toBeLessThan(insider.matched);
    expect(outsider.passthroughChars).toBeLessThan(insider.passthroughChars);
  });

  it("does not report a ratio for a query that bypassed the arms", async () => {
    // A ticket key answers out of the entity route in one call. Cheaper still,
    // but a different mechanism — reporting a ratio would compare two things
    // that are not comparable.
    const r = await measureContextCost(client, VIEWER, "PAY-981", 8, 1);
    expect(r.ratio).toBeNull();
    expect(r.note).toContain("without a result set");
  });

  it("flags matches too long for one get_doc window", async () => {
    await upsertDocument(
      client,
      CanonicalDoc.parse({
        id: "confluence:page:huge",
        source: "confluence",
        title: "Settlement runbook, the long one",
        body: longBody("settlement", 400),
        aclGroups: [],
        links: [],
      }),
    );
    const r = await measure(VIEWER);
    expect(r.windowedDocs).toBeGreaterThan(0);
  });
});
