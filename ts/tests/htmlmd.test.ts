import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Confluence storage format is XHTML plus an ac:/ri: macro vocabulary — it is
 * not HTML, and the converter previously handled none of it. Each case here is
 * a reproduced loss, not a hypothetical: before this suite, a macro code block
 * vanished entirely (CDATA took htmlparser2's bogus-comment path with no
 * handler), tables emitted no delimiter row so they were not tables at all, and
 * an ac:link contributed neither its text nor its target.
 */
describe("htmlToMarkdown — Confluence storage format", () => {
  const codeMacro = `<ac:structured-macro ac:name="code" ac:schema-version="1">
  <ac:parameter ac:name="language">bash</ac:parameter>
  <ac:plain-text-body><![CDATA[if [ "$RETRY" -gt 3 ]; then
    echo "giving up"
    exit 1
fi]]></ac:plain-text-body>
</ac:structured-macro>`;

  it("preserves a macro code block, verbatim and fenced", () => {
    const md = htmlToMarkdown(codeMacro);
    expect(md).toContain("giving up");
    // Indentation is the whole point of a code block; ontext used to collapse it.
    expect(md).toContain('    echo "giving up"');
    expect(md).toContain("```bash");
    expect(md.trimEnd().endsWith("```")).toBe(true);
  });

  it("does not leak ac:parameter metadata into prose", () => {
    // "bash" belongs in the fence info string, not as a stray paragraph.
    const md = htmlToMarkdown(`<p>before</p>${codeMacro}<p>after</p>`);
    expect(md).not.toMatch(/^\s*bash\s*$/m);
    expect(md).toContain("before");
    expect(md).toContain("after");
  });

  it("preserves a noformat macro without inventing a language", () => {
    const md = htmlToMarkdown(
      '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[  raw   text]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(md).toContain("```\n  raw   text\n```");
  });

  it("emits a header delimiter so a table is actually a table", () => {
    const md = htmlToMarkdown(
      "<table><tbody><tr><th>Band</th><th>Limit</th></tr><tr><td>A</td><td>500</td></tr></tbody></table>",
    );
    expect(md).toContain("| Band | Limit |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| A | 500 |");
    // The delimiter must sit between header and first data row, not anywhere.
    const lines = md.split("\n").filter((l) => l.startsWith("|"));
    expect(lines[0]).toContain("Band");
    expect(lines[1]).toMatch(/^\|( --- \|)+$/);
    expect(lines[2]).toContain("A");
  });

  it("treats the first row as the header when a table has no th", () => {
    const md = htmlToMarkdown(
      "<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    const lines = md.split("\n").filter((l) => l.startsWith("|"));
    expect(lines[1]).toMatch(/^\|( --- \|)+$/);
    expect(lines).toHaveLength(3);
  });

  it("escapes a pipe inside a cell so it cannot forge a column", () => {
    const md = htmlToMarkdown("<table><tr><th>h</th></tr><tr><td>a|b</td></tr></table>");
    expect(md).toContain("a\\|b");
  });

  it("keeps both the text and the target of a native internal link", () => {
    const md = htmlToMarkdown(
      '<p>See <ac:link><ri:page ri:content-title="Retry Policy" ri:space-key="ENG"/><ac:plain-text-link-body><![CDATA[the policy]]></ac:plain-text-link-body></ac:link> for detail.</p>',
    );
    expect(md).toContain("the policy");
    expect(md).toContain("Retry Policy");
    expect(md).not.toContain("See  for");
  });

  it("falls back to the page title when an ac:link carries no body", () => {
    const md = htmlToMarkdown('<ac:link><ri:page ri:content-title="Payment Runbook"/></ac:link>');
    expect(md).toContain("Payment Runbook");
  });

  it("renders an attachment link rather than dropping it", () => {
    const md = htmlToMarkdown('<ac:link><ri:attachment ri:filename="design.pdf"/></ac:link>');
    expect(md).toContain("design.pdf");
  });

  it("renders an info panel as a blockquote", () => {
    const md = htmlToMarkdown(
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Heads up.</p></ac:rich-text-body></ac:structured-macro>',
    );
    expect(md).toContain("> ");
    expect(md).toContain("Heads up.");
  });

  it("renders blockquote and hr", () => {
    expect(htmlToMarkdown("<blockquote><p>quoted</p></blockquote>")).toContain("> quoted");
    expect(htmlToMarkdown("<p>a</p><hr/><p>b</p>")).toContain("---");
  });

  it("is deterministic over the full storage vocabulary", () => {
    const html = `<p>x</p>${codeMacro}<table><tr><th>a</th></tr><tr><td>1</td></tr></table>`;
    expect(htmlToMarkdown(html)).toBe(htmlToMarkdown(html));
  });

  it("matches the golden storage-format fixture byte for byte", () => {
    const root = join(import.meta.dirname, "..", "..");
    const storage = readFileSync(join(root, "tests/fixtures/confluence_storage_page.xml"), "utf-8");
    const expected = readFileSync(join(root, "tests/golden/confluence_storage_page.md"), "utf-8");
    expect(htmlToMarkdown(storage)).toBe(expected);
  });
});
