import { describe, expect, it } from "vitest";
import {
  type Scope,
  cursorKey,
  parseConfluenceScopes,
  parseJiraScopes,
  predicate,
} from "../connectors/scope.js";

describe("parseConfluenceScopes", () => {
  it("defaults to the whole instance", () => {
    expect(parseConfluenceScopes({})).toEqual([{ kind: "all" }]);
  });
  it("expands --space to one scope per key", () => {
    expect(parseConfluenceScopes({ space: "ENG, OPS" })).toEqual([
      { kind: "space", key: "ENG" },
      { kind: "space", key: "OPS" },
    ]);
  });
  it("batches --page ids into one scope, honoring --with-descendants", () => {
    expect(parseConfluenceScopes({ page: "12345,678", withDescendants: true })).toEqual([
      { kind: "pages", ids: ["12345", "678"], withDescendants: true },
    ]);
  });
  it("passes --query through raw", () => {
    expect(parseConfluenceScopes({ query: "label = incident" })).toEqual([
      { kind: "query", q: "label = incident" },
    ]);
  });
  it("rejects two selector families", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", page: "1" })).toThrow(/at most one/);
  });
  it("rejects --with-descendants without --page", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", withDescendants: true })).toThrow(
      /--with-descendants/,
    );
  });
  it("rejects --reconcile with a selector", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", reconcile: true })).toThrow(/full-instance/);
  });
  it("rejects --fixture with a selector", () => {
    expect(() => parseConfluenceScopes({ space: "ENG", fixture: "f.json" })).toThrow(/fixture/);
  });
  it("rejects an invalid space key", () => {
    expect(() => parseConfluenceScopes({ space: 'ENG" or x' })).toThrow(/invalid/i);
  });
});

describe("parseJiraScopes", () => {
  it("expands --project per key and batches --issue", () => {
    expect(parseJiraScopes({ project: "PAY,CHK" })).toEqual([
      { kind: "project", key: "PAY" },
      { kind: "project", key: "CHK" },
    ]);
    expect(parseJiraScopes({ issue: "PAY-981,PAY-42" })).toEqual([
      { kind: "issues", keys: ["PAY-981", "PAY-42"] },
    ]);
  });
  it("rejects an invalid issue key", () => {
    expect(() => parseJiraScopes({ issue: "not a key" })).toThrow(/invalid/i);
  });
});

describe("cursorKey", () => {
  it("maps scopes to stable keys; explicit scopes have none", () => {
    expect(cursorKey("confluence", { kind: "all" })).toBe("confluence");
    expect(cursorKey("confluence", { kind: "space", key: "ENG" })).toBe("confluence:space:ENG");
    expect(cursorKey("jira", { kind: "project", key: "PAY" })).toBe("jira:project:PAY");
    expect(
      cursorKey("confluence", { kind: "pages", ids: ["1"], withDescendants: false }),
    ).toBeNull();
    expect(cursorKey("jira", { kind: "issues", keys: ["PAY-1"] })).toBeNull();
    const q: Scope = { kind: "query", q: "label = incident" };
    const k = cursorKey("confluence", q)!;
    expect(k).toMatch(/^confluence:query:[0-9a-f]{12}$/);
    expect(cursorKey("confluence", q)).toBe(k); // stable
  });
});

describe("predicate", () => {
  it("builds CQL/JQL fragments; none for all/explicit", () => {
    expect(predicate({ kind: "all" })).toBeNull();
    expect(predicate({ kind: "space", key: "ENG" })).toBe('space = "ENG"');
    expect(predicate({ kind: "project", key: "PAY" })).toBe('project = "PAY"');
    expect(predicate({ kind: "query", q: "label = x" })).toBe("(label = x)");
    expect(predicate({ kind: "pages", ids: ["1"], withDescendants: false })).toBeNull();
  });
});
