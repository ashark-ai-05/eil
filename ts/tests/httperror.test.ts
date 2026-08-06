/**
 * HttpRequestError must never carry a secret — not in `.message`, not in
 * `.info`, not in anything `JSON.stringify`/`console.log`/`{...err}` would
 * surface. Redaction happens at construction (inside `httpError()`), not at
 * some later logging call site that could forget to scrub.
 */
import { describe, expect, it } from "vitest";
import { HttpRequestError, httpError } from "../connectors/httperror.js";

describe("httpError construction", () => {
  it("redacts userinfo out of the origin/path it retains", () => {
    const url = new URL("https://tok:xyz@jira.example.com/rest/api/2/issue/PAY-1");
    const err = httpError("GET", url, 500);
    expect(err.info.origin).toBe("https://jira.example.com");
    expect(err.message).not.toContain("tok");
    expect(err.message).not.toContain("xyz");
    expect(JSON.stringify(err)).not.toContain("tok");
    expect(JSON.stringify(err)).not.toContain("xyz");
  });

  it("redacts a token-shaped query parameter", () => {
    const url = new URL("https://jira.example.com/rest/api/2/search?token=abc123&jql=x");
    const err = httpError("GET", url, 429);
    expect(err.info.path).toContain("token=***");
    expect(err.info.path).not.toContain("abc123");
    expect(err.message).not.toContain("abc123");
  });

  it("redacts percent-encoded userinfo", () => {
    const url = new URL("https://user:p%40ss@jira.example.com/rest/api/2/myself");
    const err = httpError("GET", url, 401);
    expect(err.message).not.toContain("p@ss");
    expect(err.message).not.toContain("p%40ss");
    expect(err.message).not.toContain("user");
  });

  it("carries status and code, and retryAfterMs only when given", () => {
    const url = new URL("https://jira.example.com/rest/api/2/search");
    const withHint = httpError("GET", url, 429, 5000);
    expect(withHint.info).toEqual({
      method: "GET",
      origin: "https://jira.example.com",
      path: "/rest/api/2/search",
      status: 429,
      retryAfterMs: 5000,
      code: "http_status",
    });

    const withoutHint = httpError("GET", url, 500);
    expect(withoutHint.info.retryAfterMs).toBeUndefined();
    expect("retryAfterMs" in withoutHint.info).toBe(false); // absent, not present-as-undefined
  });

  it("never retains the response body, headers, or the DcClient — only method/origin/path/status/code", () => {
    const url = new URL("https://tok:xyz@jira.example.com/rest/api/2/search?token=abc");
    const err = httpError("POST", url, 403);
    const enumerableKeys = Object.keys(err).sort();
    // `name` is Error's own harmless instance property; `info` is the only
    // thing this constructor added — nothing else it was given access to
    // (body, headers, DcClient) ever becomes an own property.
    expect(enumerableKeys).toEqual(["info", "name"]);
    expect(Object.keys(err.info).sort()).toEqual(["code", "method", "origin", "path", "status"]);
  });

  it("is an instance of HttpRequestError and a real Error", () => {
    const err = httpError("GET", new URL("https://x.example.com/y"), 500);
    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HttpRequestError");
  });
});
