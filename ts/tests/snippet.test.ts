import { describe, expect, it } from "vitest";
import { chunkHash, contentHash } from "../contracts/models.js";
import type { Db } from "../db.js";
import type { Embedder } from "../embed/index.js";
import {
  SNIPPET_COVERAGE_OPTS,
  SNIPPET_OPTS,
  localViewer,
  searchDocs,
  sliceSnippet,
} from "../search.js";
import { openTestDb, seedDoc, testViewer } from "./helpers/db.js";

/** Insert a document with EXPLICIT, separate chunks — seedDoc only ever
 *  writes one chunk at seq 0, which cannot reproduce a bug that depends on
 *  the matched chunk being shorter than the document around it (C1 below). */
async function seedMultiChunkDoc(
  db: Db,
  opts: { id: string; chunks: string[]; headingPath: string },
): Promise<void> {
  const body = opts.chunks.join("\n\n");
  const doc = {
    title: opts.id,
    url: null,
    hierarchy: [],
    aclGroups: [],
    qualityTier: "authored" as const,
    updatedAt: null,
    body,
  };
  await db.query(
    "INSERT INTO documents (id, tenant, source, title, quality_tier, content_hash, body, ingested_by)" +
      " VALUES ($1, 'default', 'confluence', $2, 'authored', $3, $4, $5)",
    [opts.id, opts.id, contentHash(doc), body, testViewer().principal],
  );
  for (let seq = 0; seq < opts.chunks.length; seq++) {
    const text = opts.chunks[seq]!;
    await db.query(
      "INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash)" +
        " VALUES ('default', $1, $2, $3, $4, $5)",
      [opts.id, seq, opts.headingPath, text, chunkHash({ text })],
    );
  }
}

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

  // C1 (review, fix round 1): truncated must describe the DOCUMENT get_doc
  // would return, not the one matched chunk. A real Confluence page
  // (tests/golden/confluence_page.chunks.json) is 5 chunks of 103-213 chars,
  // every one inside the snippet budget on its own — a chunk-scoped
  // comparison called every one of them fully covered while get_doc actually
  // held four more sections the agent never saw.
  it("reports truncated on a multi-chunk document even when the matched chunk alone fits the budget", async () => {
    const db = await openTestDb();
    await seedMultiChunkDoc(db, {
      id: "conf:multi",
      chunks: [
        // Short enough that a CHUNK-scoped comparison would call it fully
        // covered on its own.
        "Payment Retry Policy. Retry uses backoff for payments.",
        // Not matched by the query below (shares no query terms), but part of
        // the same document — get_doc would return this too.
        "Escalation: after five attempts, page on-call and open an incident. " +
          "Refunds: reverse the charge and notify the customer within one business day.",
      ],
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff", 5);
    expect(out.results[0].id).toBe("conf:multi");
    expect(out.results[0].truncated).toBe(true);
  });

  // I2 (review, fix round 1): literal "**" in the SOURCE text — the realistic
  // case is ts/ingest/confluence.ts:36, which prefixes every labelled
  // Confluence page with "**Labels:** a, b\n\n<body>" — must not be mistaken
  // for ts_headline's highlight markers when measuring coverage. A chunk that
  // is fully covered must still report truncated:false even though it starts
  // with literal "**" of its own. (A leading STOPWORD immediately before the
  // first matched term is a separate, deeper ts_headline behaviour — see the
  // doc_len comment in the lexical query — which is why this case anchors the
  // match right after the labels line rather than after an English stopword.)
  it("does not mark a snippet truncated because the source text itself contains **", async () => {
    const db = await openTestDb();
    await seedDoc(db, {
      id: "conf:bold",
      text: "**Labels:** payments, ops\n\nRetry uses backoff throughout the entire policy.",
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff", 5);
    expect(out.results[0].id).toBe("conf:bold");
    expect(out.results[0].truncated).toBe(false);
  });

  // C1 on the vector arm: the same chunk-vs-document confusion existed in
  // vecArm's fallback snippet (a plain slice of the matched chunk, compared
  // against that chunk's own length). Previously untested.
  it("reports truncated on the vector arm too, for a multi-chunk document", async () => {
    const db = await openTestDb();
    const { upsertDocument } = await import("../store.js");
    const { backfill } = await import("../embed/backfill.js");
    const marker = "Zylofrantic outage signature";
    const filler = "Unrelated filler describing the follow-up review process in detail, ".repeat(6);
    const body = `## Alpha\n${marker}: services degraded during the incident window.\n\n## Beta\n${filler}so this second section is clearly longer than the first, and the document as a whole is much bigger than the one chunk the vector arm will match on.`;
    await upsertDocument(db, {
      id: "jira:issue:VEC-1",
      tenant: "default",
      source: "jira",
      title: "Vector multi-chunk",
      hierarchy: [],
      aclGroups: [],
      qualityTier: "authored",
      body,
      links: [],
    } as any);
    // Stub: query "zzz" and the marker chunk both embed to [1,0,0]; everything
    // else (including the doc's own second chunk) embeds to [0,1,0] — "zzz"
    // shares no words with the body, so only the vec arm can surface this doc.
    const stubEmbed: Embedder = {
      id: "stub:snippet-c1",
      windowChars: 1_000_000,
      embed: async (texts) =>
        texts.map((t) =>
          t.includes(marker) || t === "zzz"
            ? Float32Array.from([1, 0, 0])
            : Float32Array.from([0, 1, 0]),
        ),
    };
    await backfill(db, stubEmbed, { reembed: true });
    const out: any = await searchDocs(db, localViewer(), "zzz", 8, stubEmbed);
    const hit = (out.results as any[]).find((r) => r.id === "jira:issue:VEC-1");
    expect(hit).toBeDefined();
    expect(hit.truncated).toBe(true);
  });

  // Round 3 (new work, directed by the human partner): truncated collapsing
  // to (correctly) true on any multi-chunk document — see the doc comment on
  // SearchResult.truncated — removed the actionable signal the flag was
  // supposed to give an agent. section_index/section_count give it back:
  // WHICH chunk matched, and how many the document has, so an agent that
  // finds its answer in section 2 of 5 can stop without needing truncated to
  // ever read false.
  it("reports section_index/section_count on the lexical arm for a multi-chunk document", async () => {
    const db = await openTestDb();
    await seedMultiChunkDoc(db, {
      id: "conf:sections",
      chunks: [
        "Retry policy uses backoff for payments.",
        "Escalation procedure for unresolved retries.",
        "Refund procedure once a retry is abandoned.",
      ],
      headingPath: "Retry",
    });
    const out: any = await searchDocs(db, testViewer(), "retry backoff", 5);
    const hit = (out.results as any[]).find((r) => r.id === "conf:sections");
    expect(hit).toBeDefined();
    expect(hit.section_index).toBe(0); // the only chunk containing "backoff"
    expect(hit.section_count).toBe(3); // real count — would fail if hardcoded to 1
  });

  it("reports section_index/section_count on the vector arm for a multi-chunk document", async () => {
    const db = await openTestDb();
    const { upsertDocument } = await import("../store.js");
    const { backfill } = await import("../embed/backfill.js");
    const marker = "Plovantex incident signature";
    const filler = "Unrelated filler describing the follow-up review process in detail, ".repeat(6);
    const body = `## Alpha\n${marker}: services degraded during the window.\n\n## Beta\n${filler}more unrelated content for the second section.\n\n## Gamma\nA third heading forces a third chunk, distinct from the first two.`;
    await upsertDocument(db, {
      id: "jira:issue:VEC-SEC",
      tenant: "default",
      source: "jira",
      title: "Vector sections",
      hierarchy: [],
      aclGroups: [],
      qualityTier: "authored",
      body,
      links: [],
    } as any);
    const stubEmbed: Embedder = {
      id: "stub:vec-sections",
      windowChars: 1_000_000,
      embed: async (texts) =>
        texts.map((t) =>
          t.includes(marker) || t === "zzz"
            ? Float32Array.from([1, 0, 0])
            : Float32Array.from([0, 1, 0]),
        ),
    };
    await backfill(db, stubEmbed, { reembed: true });
    const out: any = await searchDocs(db, localViewer(), "zzz", 8, stubEmbed);
    const hit = (out.results as any[]).find((r) => r.id === "jira:issue:VEC-SEC");
    expect(hit).toBeDefined();
    expect(hit.section_index).toBe(0); // Alpha, the marker chunk, is chunk 0
    expect(hit.section_count).toBe(3); // real count — would fail if hardcoded to 1
  });

  it("agrees on section_count between arms for the same document", async () => {
    const db = await openTestDb();
    const { upsertDocument } = await import("../store.js");
    const { backfill } = await import("../embed/backfill.js");
    // "quorbatnil" is a real word, findable lexically; also embedded as the
    // semantic anchor below — the SAME document is reached through EITHER
    // arm depending on which query and embedder a given call uses, so both
    // paths report section_count for the identical, known 2-chunk document.
    const marker = "Quorbatnil incident signature";
    const filler = "Unrelated filler describing the follow-up review process in detail, ".repeat(6);
    const body =
      `## Alpha\n${marker}: services degraded during the incident window.\n\n` +
      `## Beta\n${filler}so this second section is clearly longer than the first.`;
    await upsertDocument(db, {
      id: "jira:issue:AGREE-1",
      tenant: "default",
      source: "jira",
      title: "Agreement check",
      hierarchy: [],
      aclGroups: [],
      qualityTier: "authored",
      body,
      links: [],
    } as any);

    // Lexical-only path: every text embeds to the SAME vector, so cosine
    // carries no signal and the lexical match (a real word in chunk 0) is
    // what actually surfaces the doc; byDoc's dedup means the lexical arm's
    // fields win regardless of what the vec arm also nominally matches.
    const flatEmbed: Embedder = {
      id: "stub:agree-lex",
      windowChars: 1_000_000,
      embed: async (texts) => texts.map(() => Float32Array.from([0, 1, 0])),
    };
    await backfill(db, flatEmbed, { reembed: true });
    const lexOut: any = await searchDocs(db, localViewer(), "quorbatnil", 8, flatEmbed);
    const lexHit = (lexOut.results as any[]).find((r) => r.id === "jira:issue:AGREE-1");
    expect(lexHit).toBeDefined();

    // Vector-only path: "zzz" shares no word with the body, so only the vec
    // arm can surface it — same document, same real chunk count.
    const vecEmbed: Embedder = {
      id: "stub:agree-vec",
      windowChars: 1_000_000,
      embed: async (texts) =>
        texts.map((t) =>
          t.includes(marker) || t === "zzz"
            ? Float32Array.from([1, 0, 0])
            : Float32Array.from([0, 1, 0]),
        ),
    };
    await backfill(db, vecEmbed, { reembed: true });
    const vecOut: any = await searchDocs(db, localViewer(), "zzz", 8, vecEmbed);
    const vecHit = (vecOut.results as any[]).find((r) => r.id === "jira:issue:AGREE-1");
    expect(vecHit).toBeDefined();

    expect(lexHit.section_count).toBe(2);
    expect(vecHit.section_count).toBe(2);
    expect(lexHit.section_count).toBe(vecHit.section_count);
    expect(lexHit.section_index).toBe(0);
    expect(vecHit.section_index).toBe(0);
  });
});

// Minor (review, fix round 1): a raw text.slice() could split a word or a
// UTF-16 surrogate pair. sliceSnippet() is the fix; these are direct unit
// tests of that boundary logic rather than round-tripping through search.
describe("sliceSnippet", () => {
  it("does not cut the last word in half", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    // 12 chars lands inside "brown" ("The quick br").
    expect(sliceSnippet(text, 12)).toBe("The quick");
  });

  it("does not split a UTF-16 surrogate pair", () => {
    const emoji = "\u{1F389}"; // 🎉, a surrogate pair in UTF-16
    const text = `abc${emoji}def`;
    // Cuts exactly on the low surrogate (index 4: 'a','b','c', high, [low]).
    const out = sliceSnippet(text, 4);
    expect(out === "abc" || out === `abc${emoji}`).toBe(true);
  });

  it("falls back to a raw cut rather than collapsing a single long token to nothing", () => {
    const token = "x".repeat(50);
    expect(sliceSnippet(token, 10)).toHaveLength(10);
  });

  it("returns the text unchanged when it already fits", () => {
    expect(sliceSnippet("short", 100)).toBe("short");
  });
});

// NEW-2 (review, fix round 2): SNIPPET_COVERAGE_OPTS used to be derived by
// String.replace()-ing the literal marker spelling out of SNIPPET_OPTS — an
// edit to that spelling elsewhere would have made the replace silently
// no-op, and coverage would then be measured WITH markers still in it
// (dangerous direction: an inflated coverage_len reads as more-covered than
// the snippet actually is). Now both are derived from one shared fragment-
// sizing constant, so they cannot drift apart; this test is defense in
// depth against a future edit reopening the old failure mode by some other
// route (e.g. hand-editing one constant and not the other).
describe("SNIPPET_COVERAGE_OPTS", () => {
  it("differs from SNIPPET_OPTS and carries no marker spelling", () => {
    expect(SNIPPET_COVERAGE_OPTS).not.toBe(SNIPPET_OPTS);
    expect(SNIPPET_COVERAGE_OPTS).not.toContain("**");
  });

  it("shares the same fragment sizing as SNIPPET_OPTS — only the markers differ", () => {
    const stripMarkers = (opts: string) => opts.replace(/StartSel="[^"]*", StopSel="[^"]*", /, "");
    expect(stripMarkers(SNIPPET_COVERAGE_OPTS)).toBe(stripMarkers(SNIPPET_OPTS));
  });
});
