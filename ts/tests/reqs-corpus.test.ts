import { describe, expect, it } from "vitest";
import { BANNER, buildCorpus } from "../../scripts/build-corpus.js";

/**
 * The variants that were actually checked when the corpus was written. Asserting
 * only "in-flight" and "fx rate" would pass a page that said "orders already
 * working at the venue are cancelled" or "converted at the ECB reference rate",
 * which is exactly the fact the demo needs to be missing. `fx` is bounded so it
 * does not trip on unrelated substrings; USD stays permitted, because "250m USD
 * equivalent" in ptrd-7 is deliberate.
 */
const ABSENT_FACTS = [
  /in-flight/,
  /in flight/,
  /inflight/,
  /working at the venue/,
  /cross-currency/,
  /exchange rate/,
  /rate source/,
  /\bfx\b/,
];

/** The two planted credentials, matched the way ts/ingest/secrets.ts matches them. */
const PLANTED_SECRETS = [/\bAKIA[A-Z0-9]{16}\b/, /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@/];

describe("corpus", () => {
  it("emits 8 pages and 5 issues", () => {
    const { pages, issues } = buildCorpus();
    expect(pages).toHaveLength(8);
    expect(issues).toHaveLength(5);
  });

  it("opens every body with the banner verbatim", () => {
    const { pages, issues } = buildCorpus();
    // Verbatim and first is the binding constraint: a reader who scrolls past a
    // reworded or buried banner may take the page for a real one.
    for (const p of pages) expect(p.body.startsWith(`${BANNER}\n\n`)).toBe(true);
    for (const i of issues) {
      expect(i.fields.description.startsWith(`${BANNER}\n\n`)).toBe(true);
    }
  });

  it("restricts only the counterparty static data page", () => {
    const { pages } = buildCorpus();
    const restricted = pages.filter((p) => p.acl_groups.length > 0);
    expect(restricted.map((p) => p.id)).toEqual(["ptrd-7"]);
    expect(restricted[0]!.acl_groups).toEqual(["grp-risk-ops"]);
  });

  it("plants both detectable secrets in exactly one page", () => {
    const { pages } = buildCorpus();
    const six = pages.find((p) => p.id === "ptrd-6")!.body;
    for (const re of PLANTED_SECRETS) expect(six).toMatch(re);
    for (const re of PLANTED_SECRETS) {
      const carrying = pages.filter((p) => re.test(p.body)).map((p) => p.id);
      expect(carrying).toEqual(["ptrd-6"]);
    }
  });

  it("leaves the two escalation gaps genuinely unanswered", () => {
    const { pages } = buildCorpus();
    for (const p of pages) {
      const body = p.body.toLowerCase();
      for (const re of ABSENT_FACTS) {
        expect(body, `${p.id} answers a gap the demo needs open: ${re}`).not.toMatch(re);
      }
    }
  });

  it("keeps ptrd-3 and ptrd-8 in conflict on granularity", () => {
    const { pages } = buildCorpus();
    const three = pages.find((p) => p.id === "ptrd-3")!.body;
    const eight = pages.find((p) => p.id === "ptrd-8")!.body;
    // Both halves: a truncated ptrd-8 would satisfy the negative on its own.
    expect(three).toContain("per counterparty and legal entity");
    expect(eight).toContain("per counterparty");
    expect(eight).not.toContain("legal entity");
  });

  it("gives PTR-401 the same outbound edges the paste instructions do", () => {
    const { issues } = buildCorpus();
    const links = issues.find((i) => i.key === "PTR-401")!.fields.issue_links ?? [];
    expect(links.map((l) => l.key)).toEqual(["PTR-392", "PTR-415", "PTR-420"]);
    // Jira shows a relates-to from both sides, so the fixtures must too.
    for (const key of ["PTR-392", "PTR-415", "PTR-420"]) {
      const back = issues.find((i) => i.key === key)!.fields.issue_links ?? [];
      expect(back.map((l) => l.key)).toContain("PTR-401");
    }
  });

  it("PTR-420 states a question and answers nothing", () => {
    const { issues } = buildCorpus();
    const t = issues.find((i) => i.key === "PTR-420")!;
    expect(t.fields.status).toBe("Open");
    expect(t.fields.comments.some((c) => /no decision yet/i.test(c.body))).toBe(true);
  });
});
