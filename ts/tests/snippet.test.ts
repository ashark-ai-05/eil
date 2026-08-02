import { describe, expect, it } from "vitest";
import { searchDocs } from "../search.js";
import { openTestDb, seedDoc, testViewer } from "./helpers/db.js";

describe("snippets", () => {
  // NOTE: an earlier draft of this plan opened with
  // `expect(SNIPPET_OPTS).toContain("MaxWords=90")`. That asserts a constant's
  // spelling rather than any behaviour — it cannot fail for any reason that
  // matters and it pins the implementation instead of the contract. Deleted
  // deliberately; the two tests below cover the behaviour that the wider
  // snippet is FOR. Do not reinstate it.

  it("returns an extract long enough to answer from", async () => {
    const db = await openTestDb();
    await seedDoc(db, {
      id: "conf:long",
      text: "The retry policy uses exponential backoff. ".repeat(80),
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff policy", 5);
    // The old MaxWords=40 produced ~200 characters, below the point where an
    // extract can answer anything, so the agent fetched the whole document.
    expect(out.results[0].snippet.replaceAll("**", "").length).toBeGreaterThan(300);
  });

  it("marks a snippet that does not cover the whole chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, {
      id: "conf:long",
      text: `${"The retry policy uses exponential backoff. ".repeat(80)}`,
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff policy", 5);
    expect(out.results[0].truncated).toBe(true);
  });

  it("does not mark a snippet that covers its whole chunk", async () => {
    const db = await openTestDb();
    await seedDoc(db, { id: "conf:short", text: "Retry uses backoff.", headingPath: "Retry" });
    const out: any = await searchDocs(db, testViewer(), "retry backoff", 5);
    expect(out.results[0].truncated).toBe(false);
  });
});
