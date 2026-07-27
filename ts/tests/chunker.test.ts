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

  it("prefixes every chunk with its breadcrumb", () => {
    for (const c of chunksAsGolden()) {
      expect(c.text.startsWith(c.heading_path)).toBe(true);
      expect(c.heading_path.startsWith("Payment Retry Policy")).toBe(true);
    }
  });

  it("bounds chunk size", () => {
    for (const c of chunksAsGolden()) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS + c.heading_path.length + 2);
    }
  });
});
