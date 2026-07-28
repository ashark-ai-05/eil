import { describe, expect, it } from "vitest";
import { chunk } from "../core/chunker.js";

const codeDoc = (body: string) =>
  ({
    id: "code:r:a.ts",
    tenant: "default",
    source: "code",
    title: "src/a.ts",
    hierarchy: ["r", "src"],
    aclGroups: [],
    qualityTier: "authored",
    body,
    links: [],
  }) as any;

describe("code chunker", () => {
  it("windows code by lines with L-range headings", () => {
    const body = Array.from({ length: 130 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = chunk(codeDoc(body));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.headingPath).toBe("src/a.ts › L1-60");
    expect(chunks[0]!.text.startsWith("src/a.ts › L1-60\n\n")).toBe(true);
    expect(chunks[0]!.text).toContain("line1");
    // overlap: window 2 starts before window 1 ends (60 - 10 = 51)
    expect(chunks[1]!.headingPath).toBe("src/a.ts › L51-110");
    // deterministic
    expect(chunk(codeDoc(body))).toEqual(chunks);
  });
  it("leaves the prose path unchanged for non-code docs", () => {
    const prose = {
      id: "x",
      tenant: "default",
      source: "jira",
      title: "T",
      hierarchy: [],
      aclGroups: [],
      qualityTier: "authored",
      body: "## H\n\nsome text",
      links: [],
    } as any;
    const chunks = chunk(prose);
    expect(chunks[0]!.headingPath).toContain("T"); // section breadcrumb, not L-range
    expect(chunks[0]!.headingPath).not.toMatch(/› L\d/);
  });
});
