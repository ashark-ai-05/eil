import { describe, expect, it } from "vitest";
import { WINDOW_OVERLAP, embedWindows } from "../embed/window.js";

const CAP = 100;

describe("embedWindows", () => {
  it("returns a single prefixed window when the text fits", () => {
    const out = embedWindows("Page > Section", "short body", CAP);
    expect(out).toEqual(["Page > Section\n\nshort body"]);
  });

  it("returns the bare text when there is no heading", () => {
    expect(embedWindows("", "short body", CAP)).toEqual(["short body"]);
  });

  it("never exceeds the window", () => {
    const out = embedWindows("H", "x".repeat(1000), CAP);
    expect(out.length).toBeGreaterThan(1);
    for (const w of out) expect(w.length).toBeLessThanOrEqual(CAP);
  });

  it("repeats the heading on every window", () => {
    const out = embedWindows("Breadcrumb", "y".repeat(1000), CAP);
    for (const w of out) expect(w.startsWith("Breadcrumb\n\n")).toBe(true);
  });

  it("overlaps consecutive windows", () => {
    const text = Array.from({ length: 400 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const out = embedWindows("", text, CAP);
    const first = out[0]!;
    const second = out[1]!;
    const budget = CAP;
    const step = Math.floor(budget * (1 - WINDOW_OVERLAP));
    expect(second).toBe(text.slice(step, step + budget));
    expect(step).toBeLessThan(budget); // i.e. they genuinely overlap
  });

  it("covers the whole text — the tail is never dropped", () => {
    const text = `${"z".repeat(517)}TAIL`;
    const out = embedWindows("", text, CAP);
    expect(out[out.length - 1]!.endsWith("TAIL")).toBe(true);
  });

  it("keeps one window when the embedder has no finite window", () => {
    const out = embedWindows("H", "q".repeat(50_000), Number.MAX_SAFE_INTEGER);
    expect(out).toHaveLength(1);
  });

  it("truncates a heading that would eat more than half the window", () => {
    const out = embedWindows("H".repeat(200), "body text here", CAP);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeLessThanOrEqual(CAP);
    expect(out[0]!.endsWith("body text here")).toBe(true);
  });
});
