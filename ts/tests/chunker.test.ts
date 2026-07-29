/**
 * Golden-file contract — the same goldens the Python implementation produced.
 * Byte-identical chunking is the proof the port is correct, not hopeful.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_CHARS, chunk } from "../core/chunker.js";
import { normalize } from "../ingest/confluence.js";

const FIXTURE = new URL("../../tests/fixtures/confluence_page.json", import.meta.url);
const GOLDEN = new URL("../../tests/golden/confluence_page.chunks.json", import.meta.url);

interface GoldenChunk {
  doc_id: string;
  seq: number;
  heading_path: string;
  text: string;
}

function chunksAsGolden(): GoldenChunk[] {
  const doc = normalize(JSON.parse(readFileSync(FIXTURE, "utf-8")));
  return chunk(doc).map((c) => ({
    doc_id: c.docId,
    seq: c.seq,
    heading_path: c.headingPath,
    text: c.text,
  }));
}

describe("chunker golden contract", () => {
  it("matches the language-neutral golden file exactly", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf-8")) as GoldenChunk[];
    expect(chunksAsGolden()).toEqual(golden);
  });

  it("is deterministic", () => {
    expect(chunksAsGolden()).toEqual(chunksAsGolden());
  });

  // The contract changed deliberately: a chunk carries its breadcrumb ALONGSIDE
  // the text rather than inside it. Both snippet paths read `text`, so the old
  // shape charged every snippet for the breadcrumb (9-16% of the 240-char vector
  // snippet on this shallow fixture, worse on a real hierarchy) and tied every
  // vector to the document title, making a rename a full re-embed.
  it("carries the breadcrumb beside the text, not inside it", () => {
    for (const c of chunksAsGolden()) {
      expect(c.heading_path.startsWith("Payment Retry Policy")).toBe(true);
      expect(c.text.startsWith(c.heading_path)).toBe(false);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("bounds chunk size", () => {
    // No longer needs the breadcrumb allowance: text is the piece alone.
    for (const c of chunksAsGolden()) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });
});
