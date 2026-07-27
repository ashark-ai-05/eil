import { describe, expect, it } from "vitest";
import { rrf } from "../core/fusion.js";
import { RECENCY_FLOOR, TIER_PRIOR, modifier } from "../core/ranking.js";
import { classify } from "../core/router.js";

describe("router", () => {
  it("routes ticket keys to entity", () => {
    expect(classify("what is the status of PAY-981?")).toEqual({
      route: "entity",
      match: "PAY-981",
    });
  });
  it("routes paths to code", () => {
    expect(classify("where is src/retry/scheduler.py used")).toEqual({
      route: "path",
      match: "src/retry/scheduler.py",
    });
  });
  it("routes quoted phrases and error strings to exact", () => {
    expect(classify('find "idempotency key is required"').route).toBe("exact");
    expect(classify("seeing NullPointerException in retry handler")).toEqual({
      route: "exact",
      match: "NullPointerException",
    });
  });
  it("routes identifier-shaped tokens to symbol", () => {
    expect(classify("handleRetry").route).toBe("symbol");
    expect(classify("parked_payment_alert").route).toBe("symbol");
  });
  it("falls through to docs", () => {
    expect(classify("how do payment retries work").route).toBe("docs");
    expect(classify("retry").route).toBe("docs");
  });
});

describe("rrf", () => {
  it("agreement wins", () => {
    const fused = rrf({ fts: ["a", "b", "c"], knn: ["b", "a", "d"] });
    expect(new Set(fused.slice(0, 2).map(([id]) => id))).toEqual(new Set(["a", "b"]));
  });
  it("tiebreaks deterministically on doc id", () => {
    expect(rrf({ x: ["b", "a"], y: ["a", "b"] }).map(([id]) => id)).toEqual(["a", "b"]);
  });
  it("respects weights", () => {
    const weighted = rrf({ fts: ["a"], knn: ["b"] }, { fts: 2.0 });
    expect(weighted[0]![0]).toBe("a");
    expect(weighted[0]![1]).toBeGreaterThan(weighted[1]![1]);
  });
  it("passes single-arm order through", () => {
    expect(rrf({ fts: ["z", "m", "a"] }).map(([id]) => id)).toEqual(["z", "m", "a"]);
  });
});

const NOW = new Date("2026-07-27T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("ranking", () => {
  it("fresh authored doc is neutral", () => {
    expect(modifier("authored", NOW, NOW)).toBe(1.0);
  });
  it("curated prior beats authored", () => {
    expect(modifier("curated", NOW, NOW)).toBeGreaterThan(modifier("authored", NOW, NOW));
  });
  it("decays to halfway above floor at half-life", () => {
    const expected = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5;
    expect(modifier("authored", daysAgo(180), NOW)).toBeCloseTo(expected, 9);
  });
  it("curated decays slower but does decay", () => {
    const curated = modifier("curated", daysAgo(365), NOW) / TIER_PRIOR.curated!;
    const authored = modifier("authored", daysAgo(365), NOW);
    expect(curated).toBeGreaterThan(authored);
    expect(curated).toBeLessThan(1.0);
  });
  it("treats unknown age as old", () => {
    expect(modifier("authored", null, NOW)).toBe(TIER_PRIOR.authored! * RECENCY_FLOOR);
  });
});
