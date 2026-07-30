import { describe, expect, it } from "vitest";
import { buildCorpus } from "../../scripts/build-corpus.js";

describe("corpus", () => {
  it("emits 8 pages and 5 issues", () => {
    const { pages, issues } = buildCorpus();
    expect(pages).toHaveLength(8);
    expect(issues).toHaveLength(5);
  });

  it("banners every body so nothing can be mistaken for production", () => {
    const { pages, issues } = buildCorpus();
    for (const p of pages) expect(p.body).toContain("SYNTHETIC DEMO CONTENT");
    for (const i of issues) expect(i.fields.description).toContain("SYNTHETIC DEMO CONTENT");
  });

  it("restricts only the counterparty static data page", () => {
    const { pages } = buildCorpus();
    const restricted = pages.filter((p) => p.acl_groups.length > 0);
    expect(restricted.map((p) => p.id)).toEqual(["ptrd-7"]);
    expect(restricted[0]!.acl_groups).toEqual(["grp-risk-ops"]);
  });

  it("plants a detectable secret in exactly one page", () => {
    const { pages } = buildCorpus();
    const withKeys = pages.filter((p) => p.body.includes("AKIA"));
    expect(withKeys.map((p) => p.id)).toEqual(["ptrd-6"]);
  });

  it("leaves the two escalation gaps genuinely unanswered", () => {
    const { pages } = buildCorpus();
    const all = pages
      .map((p) => p.body)
      .join("\n")
      .toLowerCase();
    expect(all).not.toContain("in-flight");
    expect(all).not.toContain("fx rate");
  });

  it("keeps ptrd-3 and ptrd-8 in conflict on granularity", () => {
    const { pages } = buildCorpus();
    const three = pages.find((p) => p.id === "ptrd-3")!.body;
    const eight = pages.find((p) => p.id === "ptrd-8")!.body;
    expect(three).toContain("legal entity");
    expect(eight).not.toContain("legal entity");
  });

  it("PTR-420 states a question and answers nothing", () => {
    const { issues } = buildCorpus();
    const t = issues.find((i) => i.key === "PTR-420")!;
    expect(t.fields.status).toBe("Open");
    expect(t.fields.comments.some((c) => /no decision yet/i.test(c.body))).toBe(true);
  });
});
