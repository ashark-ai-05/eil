import { describe, expect, it } from "vitest";
import { assemble, nextAcId } from "../reqs/assemble.js";
import { renderHtml, renderMarkdown } from "../reqs/render.js";
import { clone, minimalBody } from "./helpers/reqs-fixture.js";

describe("assemble", () => {
  it("recomputes magnitude from the bands, overwriting whatever was authored", () => {
    const b = clone(minimalBody());
    (b.tree as any).score.magnitude = 21;
    expect(assemble(b).tree.score.magnitude).toBe(2);
  });

  it("derives isLeaf from the decision", () => {
    const b = clone(minimalBody());
    (b.tree as any).isLeaf = false;
    expect(assemble(b).tree.isLeaf).toBe(true);
  });

  it("marks a hedged quote so the artefact cannot inherit false confidence", () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "There's a staleness cutoff, I think 5s",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: false,
      },
    ];
    expect(assemble(b).tree.grounding[0]!.hedged).toBe(true);
  });

  it("inverts the tree into a traceability index rather than trusting an authored one", () => {
    const b = clone(minimalBody());
    b.traceability = { "AC-99": "REQ-NOWHERE" };
    expect(assemble(b).traceability).toEqual({ "AC-1": "REQ-ROOT" });
  });

  it("counts coverage from the tree and the ledgers", () => {
    const b = clone(minimalBody());
    const out = assemble(b);
    expect(out.coverage).toEqual({
      leaves: 1,
      acs: 1,
      unknownsTotal: 1,
      grounded: 0,
      escalated: 0,
      carried: 0,
    });
  });

  it("allocates the next AC id monotonically above the highest ever used", () => {
    const b = clone(minimalBody());
    b.tree.acceptanceCriteria!.push({
      id: "AC-7",
      stakeholder: "QA",
      given: "g",
      when: "w",
      // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
      then: ["rejects with code 4001"],
      observable: true,
    });
    expect(nextAcId(b)).toBe("AC-8");
  });

  it("is idempotent — assembling twice changes nothing", () => {
    const once = assemble(clone(minimalBody()));
    expect(assemble(clone(once))).toEqual(once);
  });
});

describe("render", () => {
  it("is a pure projection — same body in, same string out", () => {
    const b = assemble(clone(minimalBody()));
    expect(renderHtml(b)).toBe(renderHtml(clone(b)));
  });

  it("stamps REFUSED when any finding is an error", () => {
    const b = assemble(clone(minimalBody()));
    const html = renderHtml(b, [
      {
        id: "SCORE-001",
        severity: "error",
        path: "tree.score",
        message: "stored 21, recomputed 2",
      },
    ]);
    expect(html).toContain("REFUSED");
    expect(html).toContain("SCORE-001");
  });

  it("does not stamp REFUSED for warnings alone", () => {
    const b = assemble(clone(minimalBody()));
    const html = renderHtml(b, [
      {
        id: "AC-005",
        severity: "warning",
        path: "tree.acceptanceCriteria.0",
        message: "not observable",
      },
    ]);
    expect(html).not.toContain("REFUSED");
  });

  it("shows the corpus mode so a run cannot be misrepresented", () => {
    const b = assemble(clone(minimalBody()));
    expect(renderMarkdown(b)).toContain("fixtures");
  });

  it("embeds no external references", () => {
    const html = renderHtml(assemble(clone(minimalBody())));
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toContain("<script");
  });
});
