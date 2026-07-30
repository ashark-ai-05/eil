import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANNER, buildCorpus } from "../../scripts/build-corpus.js";
import { normalisePack } from "../llm/index.js";
import { parseReqs } from "../reqs/schema.js";

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

/**
 * The demo's two committed artefacts. Both are generated — `pnpm demo:reqs`
 * writes them — so these are not tests of authorship; they are the invariants
 * that make the committed files honest and the tamper drill complete. A
 * regenerated pair that quietly lost one of them would still open in a browser.
 */
describe("the committed demo artefacts", () => {
  const read = (path: string) =>
    JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf-8"));

  it("labels the replay pack as authored rather than captured", () => {
    const pack = normalisePack(read("demo/PTR-401.replay.json"));
    expect(Date.parse(pack.recordedAt)).not.toBeNaN();
    // The two claims that must never drift: no model produced these, and the
    // pack says in plain English that it is not a captured production run.
    expect(pack.model).toBeNull();
    expect(pack.provider).toBe("hand-authored-during-build");
    expect(pack.note.toLowerCase()).toContain("not a captured run of a production model");
    expect(Object.keys(pack.replies).length).toBeGreaterThan(20);
    for (const [key, reply] of Object.entries(pack.replies)) {
      expect(key, "a reply keyed by anything but a prompt hash cannot be replayed").toMatch(
        /^[0-9a-f]{16}$/,
      );
      // Replay reproduces recorded timing; a reply with none would return
      // instantly and the demo would lose the rhythm the pack exists to keep.
      expect(reply.latencyMs ?? -1).toBeGreaterThan(0);
      expect(() => JSON.parse(reply.text)).not.toThrow();
    }
  });

  it("carries everything the gate and the tamper drill need, and says it was replayed", () => {
    const parsed = parseReqs(read("demo/PTR-401.reqs.json"));
    expect(parsed.ok, parsed.ok === false ? parsed.issues.join("; ") : "").toBe(true);
    if (!parsed.ok) return;
    const body = parsed.body;

    // The artefact says what produced its judgments AND that they were replayed.
    expect(body.metadata.generator.provenance).toBe("replay");
    expect(body.metadata.generator.agent).toContain("hand-authored-during-build");
    expect(body.metadata.generator.model).toBeNull();
    // A synthetic run must never be presentable as a live one.
    expect(body.metadata.corpusMode).toBe("fixtures");

    // Tampers 3, 4 and 5 need a clarification, a citation and a sign-off; a
    // regenerated artefact missing any of them turns the drill into 3 of 6.
    expect(body.clarifications.length).toBeGreaterThan(0);
    const cited = body.clarifications.flatMap((c) => c.grounding);
    expect(cited.length).toBeGreaterThan(0);
    expect(body.signoff?.approvers.map((a) => a.role).sort()).toEqual(["PO", "QA", "TechLead"]);
    for (const a of body.signoff?.approvers ?? []) expect(a.kind).toBe("human");

    // The two escalation shapes the narration is built around: an unknown the
    // corpus answers, and one only a named human can.
    expect(body.clarifications.some((c) => c.answeredBy?.kind === "knowledge_base")).toBe(true);
    expect(body.clarifications.some((c) => c.answeredBy?.kind === "human")).toBe(true);
    // A hedged source is cited and marked as hedged rather than laundered.
    expect(cited.some((g) => g.hedged)).toBe(true);
    expect(body.residuals.some((r) => r.acceptedBy.kind === "human")).toBe(true);
  });
});
