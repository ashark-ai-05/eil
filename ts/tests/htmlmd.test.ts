import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../connectors/htmlmd.js";

describe("htmlToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    const md = htmlToMarkdown("<h2>Retry schedule</h2><p>Backoff starts at <b>30s</b>.</p>");
    expect(md).toContain("## Retry schedule");
    expect(md).toContain("Backoff starts at **30s**.");
  });

  it("handles nested and ordered lists", () => {
    const md = htmlToMarkdown("<ol><li>first</li><li>second</li></ol><ul><li>bullet</li></ul>");
    expect(md).toContain("1. first");
    expect(md).toContain("2. second");
    expect(md).toContain("- bullet");
  });

  it("preserves code and pre", () => {
    const md = htmlToMarkdown("<p>use <code>retry_key</code></p><pre>def f():\n    pass</pre>");
    expect(md).toContain("`retry_key`");
    expect(md).toContain("```\ndef f():\n    pass\n```");
  });

  it("renders links and table rows", () => {
    expect(htmlToMarkdown('<a href="https://x.example/y">runbook</a>')).toContain(
      "[runbook](https://x.example/y)",
    );
    const md = htmlToMarkdown(
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    expect(md).toContain("| a | b |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("drops scripts and collapses whitespace", () => {
    const md = htmlToMarkdown("<p>keep</p><script>alert(1)</script><p>this   too</p>");
    expect(md).not.toContain("alert");
    expect(md).toContain("this too");
  });

  it("is deterministic", () => {
    const html = "<h1>T</h1><p>body <em>x</em></p>";
    expect(htmlToMarkdown(html)).toBe(htmlToMarkdown(html));
  });
});
