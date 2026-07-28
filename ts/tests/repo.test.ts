import { describe, expect, it } from "vitest";
import { chunk } from "../core/chunker.js";
import { RepoFilter, globToRegExp } from "../ingest/repofilter.js";

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

describe("repofilter", () => {
  it("globs with **, *, ?", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a/b/c.js")).toBe(false);
    expect(globToRegExp("**/vendor/**").test("x/vendor/y/z.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false); // * doesn't cross /
  });
  it("acceptPath honors includes then excludes", () => {
    const f = new RepoFilter({ includes: ["**/*.ts"], excludes: ["**/generated/**"] });
    expect(f.acceptPath("src/a.ts")).toBe(true);
    expect(f.acceptPath("src/a.js")).toBe(false); // not included
    expect(f.acceptPath("src/generated/a.ts")).toBe(false); // excluded
  });
  it("no includes = accept all except excludes", () => {
    const f = new RepoFilter({ excludes: ["**/*.lock"] });
    expect(f.acceptPath("a/b.ts")).toBe(true);
    expect(f.acceptPath("a/b.lock")).toBe(false);
  });
  it("acceptContent rejects binary and oversize", () => {
    const f = new RepoFilter({ maxBytes: 100 });
    expect(f.acceptContent("clean text")).toBe(true);
    expect(f.acceptContent("has\0nul")).toBe(false); // binary
    expect(f.acceptContent("x".repeat(101))).toBe(false); // oversize
  });
});
