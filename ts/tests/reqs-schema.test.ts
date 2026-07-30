import { describe, expect, it } from "vitest";
import { parseReqs } from "../reqs/schema.js";
import { minimalBody } from "./helpers/reqs-fixture.js";

describe("reqs schema", () => {
  it("accepts a minimal valid body", () => {
    const r = parseReqs(minimalBody());
    expect(r.ok).toBe(true);
  });

  it("rejects a node id that does not extend its parent's pattern", () => {
    const b = minimalBody();
    (b.tree as any).id = "REQ-1";
    expect(parseReqs(b).ok).toBe(false);
  });

  it("accepts a wrong magnitude, so SCORE-001 owns that verdict not the schema", () => {
    const b = minimalBody();
    (b.tree as any).score.magnitude = 21;
    expect(parseReqs(b).ok).toBe(true);
  });

  it("accepts a forged approver kind, so GATE-006 owns that verdict", () => {
    const b = minimalBody();
    (b as any).signoff = {
      approvers: [{ name: "bot", role: "PO", kind: "agent", at: "2026-07-30T00:00:00Z" }],
      result: "partial",
    };
    expect(parseReqs(b).ok).toBe(true);
  });

  it("accepts result 'passed', so GATE-001 owns that verdict", () => {
    const b = minimalBody();
    (b as any).signoff = { approvers: [], result: "passed" };
    expect(parseReqs(b).ok).toBe(true);
  });

  it("requires at least one observable outcome on an acceptance criterion", () => {
    const b = minimalBody();
    // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
    (b.tree as any).acceptanceCriteria[0].then = [];
    expect(parseReqs(b).ok).toBe(false);
  });

  it("reports readable issue paths", () => {
    const r = parseReqs({ schemaVersion: "1.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toContain("metadata");
  });
});
