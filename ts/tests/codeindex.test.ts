import { describe, expect, it } from "vitest";
import { MAX_INDEX_VALUE_CHARS, detectLanguage, extractCodeIndex } from "../ingest/codeindex.js";
describe("deterministic code index", () => {
  it("extracts path, symbols, imports, exports, literals and tests with citations", () => {
    const hits = extractCodeIndex(
      "src/payment.test.ts",
      'import { x } from "./x";\nexport function pay(id: string) { return "ok"; }\ndescribe("pay", () => {});',
    );
    expect(detectLanguage("x.tsx")).toBe("tsx");
    expect(hits.map((x) => x.kind)).toEqual(
      expect.arrayContaining(["path", "import", "export", "symbol", "literal", "test"]),
    );
    expect(hits.find((x) => x.rawValue === "pay")).toMatchObject({
      lineStart: 2,
      symbolKind: "function",
    });
  });
});

describe("code index entries are safely insertable", () => {
  // Regression: `value` is part of code_index's primary key and a btree key
  // caps at 2704 bytes. An incompressible literal past that aborted the whole
  // repo ingest with the cursor unadvanced, so the repo could never be ingested.
  it("drops values too long to sit in the primary key", () => {
    const blob = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251)).toString("base64");
    const hits = extractCodeIndex("src/big.ts", `const DATA = "${blob}";`);
    for (const h of hits) expect(h.value.length).toBeLessThanOrEqual(MAX_INDEX_VALUE_CHARS);
    expect(hits.some((h) => h.kind === "path")).toBe(true); // the file is still indexed
  });

  // Regression: two identical literals on one line produced two entries with an
  // identical primary key, and the insert loop had no ON CONFLICT.
  it("still emits duplicates, so the writer must tolerate them", () => {
    const hits = extractCodeIndex("src/dup.ts", 'console.log("dup", "dup");');
    const keys = hits.map((h) => `${h.kind}|${h.value}|${h.lineStart}|${h.lineEnd}`);
    expect(new Set(keys).size).toBeLessThan(keys.length);
  });
});
