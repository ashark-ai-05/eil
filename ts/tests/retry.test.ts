/**
 * The livelock had two halves and needs both fixed. Nothing retried, so one 429
 * aborted a sync; and the abort escaped past setCursor, so it also discarded
 * every page of progress before it. A source that rate-limits at a fixed offset
 * therefore re-fetched the same prefix forever and never advanced.
 */
import { describe, expect, it } from "vitest";
import { httpError } from "../connectors/httperror.js";
import { backoffMs, isRetryable, parseRetryAfter, withRetry } from "../connectors/retry.js";

const noSleep = async () => {};
const url = new URL("https://dc.example.com/rest/api/content");

/** Builds the same structured error getJson/postJson/getRaw actually throw,
 *  so these tests exercise the real classification contract rather than a
 *  string shape retry.ts no longer parses. */
function statusError(status: number, retryAfterMs?: number) {
  return httpError("GET", url, status, retryAfterMs);
}

describe("retry classification", () => {
  it("retries what might succeed on a second ask", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504])
      expect(isRetryable(statusError(s))).toBe(true);
    for (const m of ["timeout", "ECONNRESET", "socket hang up", "fetch failed"])
      expect(isRetryable(new Error(m))).toBe(true);
  });

  it("does NOT retry what cannot succeed", () => {
    // Retrying these wastes the budget a real blip needs, and hides a
    // credential problem behind a minute of silence.
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryable(statusError(s))).toBe(false);
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

  it("a server hint LENGTHENS backoff but never shortens it below the normal jittered value", () => {
    // Small hint, big jittered value -> jittered wins (the hint cannot weaken the client's own backoff).
    const jittered = backoffMs(5, { baseMs: 1000, capMs: 60_000, random: () => 0.999 });
    expect(backoffMs(5, { baseMs: 1000, capMs: 60_000, random: () => 0.999 }, 10)).toBe(jittered);
    // Big hint, tiny jittered value -> hint wins.
    expect(backoffMs(0, { baseMs: 1000, capMs: 60_000, random: () => 0 }, 45_000)).toBe(45_000);
  });

  it("a server hint is still bounded by the cap", () => {
    expect(backoffMs(0, { baseMs: 1000, capMs: 60_000, random: () => 0 }, 999_999)).toBe(60_000);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("rejects a negative or non-numeric delta", () => {
    expect(parseRetryAfter("-1")).toBeNull();
    expect(parseRetryAfter("not-a-number")).toBeNull(); // falls through to date parsing, which also fails
    expect(parseRetryAfter("garbage")).toBeNull();
  });

  it("parses an HTTP-date relative to an injected clock", () => {
    const now = () => Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
  });

  it("rejects an HTTP-date that has already passed", () => {
    const now = () => Date.parse("2026-01-01T00:00:10Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBeNull();
  });

  it("returns null for a missing header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
  });
});

describe("withRetry", () => {
  it("recovers from a transient failure", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw statusError(429);
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
          throw statusError(503);
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
          throw statusError(401);
        },
        { attempts: 5, sleep: noSleep },
      ),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
  });

  it("honors a server Retry-After hint over the normal jittered delay", async () => {
    let calls = 0;
    const delays: number[] = [];
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw statusError(429, 5_000);
        return "ok";
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0, // jittered backoff would be ~0ms — the hint must still dominate
        baseMs: 1000,
        capMs: 60_000,
      },
    );
    expect(delays).toEqual([5_000]);
  });
});
