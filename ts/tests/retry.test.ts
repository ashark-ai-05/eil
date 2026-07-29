/**
 * The livelock had two halves and needs both fixed. Nothing retried, so one 429
 * aborted a sync; and the abort escaped past setCursor, so it also discarded
 * every page of progress before it. A source that rate-limits at a fixed offset
 * therefore re-fetched the same prefix forever and never advanced.
 */
import { describe, expect, it } from "vitest";
import { backoffMs, isRetryable, withRetry } from "../connectors/retry.js";

const noSleep = async () => {};

describe("retry classification", () => {
  it("retries what might succeed on a second ask", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504])
      expect(isRetryable(new Error(`GET /rest/api/content -> ${s}`))).toBe(true);
    for (const m of ["timeout", "ECONNRESET", "socket hang up", "fetch failed"])
      expect(isRetryable(new Error(m))).toBe(true);
  });

  it("does NOT retry what cannot succeed", () => {
    // Retrying these wastes the budget a real blip needs, and hides a
    // credential problem behind a minute of silence.
    for (const s of [400, 401, 403, 404, 422])
      expect(isRetryable(new Error(`GET /rest/api/content -> ${s}`))).toBe(false);
    expect(isRetryable(new Error("chunk text too long"))).toBe(false);
  });
});

describe("full jitter", () => {
  it("is bounded by min(cap, base * 2^attempt) and never negative", () => {
    for (const r of [0, 0.5, 0.999]) {
      for (let a = 0; a < 8; a++) {
        const d = backoffMs(a, { baseMs: 1000, capMs: 60_000, random: () => r });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.min(60_000, 1000 * 2 ** a));
      }
    }
  });

  it("is jittered, not a fixed schedule — the point is to desynchronise clients", () => {
    const seen = new Set(Array.from({ length: 40 }, () => backoffMs(5, { baseMs: 1000 })));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("respects the cap", () => {
    expect(backoffMs(30, { baseMs: 1000, capMs: 60_000, random: () => 0.999 })).toBeLessThanOrEqual(
      60_000,
    );
  });
});

describe("withRetry", () => {
  it("recovers from a transient failure", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("GET /x -> 429");
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the budget and surfaces the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("GET /x -> 503");
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toThrow("503");
    expect(calls).toBe(4);
  });

  it("fails a non-retryable error immediately, without burning the budget", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("GET /x -> 401");
        },
        { attempts: 5, sleep: noSleep },
      ),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});
