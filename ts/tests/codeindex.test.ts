import { describe, expect, it } from "vitest";
import { detectLanguage, extractCodeIndex } from "../ingest/codeindex.js";
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
