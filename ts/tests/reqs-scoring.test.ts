import { describe, expect, it } from "vitest";
import { FIB, REGISTERED_CONSTANTS as K } from "../reqs/constants.js";
import {
  decisionSpace,
  hasDeferral,
  hasHedge,
  isFib,
  isObservable,
  magnitude,
  recommendAction,
  zone,
} from "../reqs/scoring.js";

describe("magnitude", () => {
  it("is max, and is therefore always itself a Fibonacci band", () => {
    for (const u of FIB) for (const c of FIB) expect(isFib(magnitude(u, c))).toBe(true);
    expect(magnitude(2, 8)).toBe(8);
    expect(magnitude(13, 3)).toBe(13);
  });
});

describe("zone", () => {
  it("derives from the relationship between thresholds, not from literals", () => {
    expect(zone(1)).toBe("atomic");
    expect(zone(K.thresholdAtomic)).toBe("atomic");
    expect(zone(3)).toBe("review");
    expect(zone(K.thresholdDecompose)).toBe("must_break_down");
    expect(zone(21)).toBe("must_break_down");
  });
});

describe("decisionSpace", () => {
  it("permits only leaf in the atomic zone", () => {
    expect(decisionSpace(1, 2)).toEqual(["leaf"]);
  });
  it("permits leaf or decompose in the review zone", () => {
    expect(decisionSpace(3, 3).sort()).toEqual(["decompose", "leaf"]);
  });
  it("forbids leaf at or above the decompose threshold", () => {
    expect(decisionSpace(2, 8)).not.toContain("leaf");
  });
  it("admits clarify only once unknowns reach the floor", () => {
    expect(decisionSpace(3, 8)).not.toContain("clarify");
    expect(decisionSpace(8, 8)).toContain("clarify");
  });
  it("never admits clarify below the floor however complex", () => {
    expect(decisionSpace(2, 21)).toEqual(["decompose"]);
  });
});

describe("recommendAction", () => {
  it("routes to clarify when a structural pass failed to move the unknowns", () => {
    expect(recommendAction(8, 8, 8)).toBe("clarify");
    expect(recommendAction(13, 5, 8)).toBe("clarify");
  });
  it("decomposes when the unknowns are actually falling", () => {
    expect(recommendAction(5, 8, 13)).toBe("decompose");
  });
  it("leafs in the atomic and review zones", () => {
    expect(recommendAction(1, 1)).toBe("leaf");
    expect(recommendAction(3, 2)).toBe("leaf");
  });
});

describe("lexicons", () => {
  it("detects hedged prose so the artefact cannot launder a source's uncertainty", () => {
    expect(hasHedge("There's a staleness cutoff, I think 5s")).toBe(true);
    expect(hasHedge("Haven't measured recently")).toBe(true);
    expect(hasHedge("The cutoff is 5s, asserted in the runbook")).toBe(false);
  });
  it("detects a hedge phrase even when hard-wrapped across a newline", () => {
    expect(hasHedge("There's a staleness cutoff, I think\n5s")).toBe(true);
  });
  it("detects a hedge phrase split across a newline in the middle", () => {
    expect(hasHedge("Check with the\npsr-limits team")).toBe(true);
  });
  it("detects deferral markers", () => {
    expect(hasDeferral("latency budget TBD")).toBe(true);
    expect(hasDeferral("we will decide later")).toBe(true);
    expect(hasDeferral("the budget is 40us")).toBe(false);
  });
  it("treats an outcome as observable when it names something checkable", () => {
    expect(isObservable("the order is rejected with code 4001")).toBe(true);
    expect(isObservable("the system behaves correctly")).toBe(false);
  });
});
