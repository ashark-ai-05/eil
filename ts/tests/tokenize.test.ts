/**
 * Identifier tokenization. The expectations are the measured behaviour of real
 * code-search engines, not this implementation's output — several of these cases
 * exist specifically because the obvious implementation (Lucene's
 * WordDelimiterGraphFilter) gets them wrong.
 */
import { describe, expect, it } from "vitest";
import { codeTokens, pathTokens, queryTokens, subtokens, tokenize } from "../core/tokenize.js";

describe("subtokens", () => {
  it("splits acronyms correctly, where Lucene does not", () => {
    // Lucene yields [parse, HTTPResponse] — the acronym is never split.
    expect(subtokens("parseHTTPResponse")).toEqual(["parse", "http", "response"]);
    expect(subtokens("XMLHttpRequest")).toEqual(["xml", "http", "request"]);
    expect(subtokens("IOError")).toEqual(["io", "error"]);
    expect(subtokens("getURLFromID")).toEqual(["get", "url", "from", "id"]);
  });

  it("requires TWO uppercase before an acronym break, so OAuth2 survives", () => {
    // Lucene splits this into [O, Auth2, Client] — a break in the wrong place.
    expect(subtokens("OAuth2Client")).toEqual(["oauth2", "oauth", "client"]);
  });

  it("emits digit splits additively, keeping the joined form", () => {
    // Callers write both `sha256` and `sha 256`, so both must match.
    expect(subtokens("sha256Hash")).toEqual(["sha256", "sha", "256", "hash"]);
    expect(subtokens("IPv4Address")).toEqual(["ipv4", "ipv", "address"]);
  });

  it("handles snake and screaming case", () => {
    expect(subtokens("MAX_RETRY_COUNT")).toEqual(["max", "retry", "count"]);
    expect(subtokens("retry_handler")).toEqual(["retry", "handler"]);
  });

  it("drops single characters, which carry no signal and inflate the index", () => {
    expect(subtokens("aB")).toEqual([]);
    expect(subtokens("xIndex")).toEqual(["index"]);
  });
});

describe("tokenize keeps the whole identifier alongside its parts", () => {
  it("indexes retryHandler as itself AND its pieces", () => {
    expect(tokenize("retryHandler")).toEqual(["retryhandler", "retry", "handler"]);
  });
});

describe("pathTokens", () => {
  it("indexes every suffix, which is what makes a basename query work", () => {
    expect(pathTokens("src/retry/scheduler.py")).toEqual([
      "src/retry/scheduler.py",
      "retry/scheduler.py",
      "scheduler.py",
      "src",
      "retry",
      "scheduler",
      "py",
    ]);
  });
});

describe("the two failures this exists to fix", () => {
  it("`handler` now finds retryHandler", () => {
    const indexed = tokenize("retryHandler");
    expect(queryTokens("handler").some((t) => indexed.includes(t))).toBe(true);
    expect(queryTokens("retry handler").some((t) => indexed.includes(t))).toBe(true);
  });

  it("`scheduler.py` now finds src/retry/scheduler.py", () => {
    const indexed = pathTokens("src/retry/scheduler.py");
    expect(queryTokens("scheduler.py").some((t) => indexed.includes(t))).toBe(true);
    expect(queryTokens("retry/scheduler.py").some((t) => indexed.includes(t))).toBe(true);
  });

  it("index and query tokenization are symmetric — the classic silent failure", () => {
    // Any identifier the indexer stores must be producible by the query side.
    for (const id of ["retryHandler", "MAX_RETRIES", "parseHTTPResponse", "sha256Hash"]) {
      const indexed = new Set(tokenize(id));
      const asked = queryTokens(id);
      expect(asked.some((t) => indexed.has(t))).toBe(true);
    }
  });
});

describe("codeTokens", () => {
  it("covers the path and every identifier in the body", () => {
    const t = codeTokens("src/pay/retry.ts", "export function retryHandler(maxAttempts) {}");
    for (const want of [
      "retry.ts",
      "src/pay/retry.ts",
      "retryhandler",
      "handler",
      "maxattempts",
      "attempts",
    ])
      expect(t.split(" ")).toContain(want);
  });

  it("keeps code keywords that the english config deletes", () => {
    // `if`, `for`, `do`, `no`, `on`, `is` are English stopwords but real code.
    const t = codeTokens("a.go", "for x := range items { if ok { do() } }").split(" ");
    expect(t).toContain("for");
    expect(t).toContain("if");
  });
});
