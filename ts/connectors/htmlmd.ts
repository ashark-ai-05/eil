/**
 * Confluence storage-format (XHTML) -> markdown, deterministically.
 * htmlparser2 supplies the events; unrenderable markup degrades to text
 * content rather than leaking.
 *
 * Storage format is NOT plain HTML: it carries an `ac:`/`ri:` macro vocabulary
 * that the plain-HTML path silently destroyed. Three losses were reproduced
 * against a realistic page before this was written:
 *
 *   - A code block is `<ac:structured-macro ac:name="code">` wrapping CDATA,
 *     never `<pre>`. With no `recognizeCDATA`, htmlparser2 routes CDATA down
 *     the bogus-comment path, and with no `oncomment` handler the body was
 *     dropped outright — the highest-value span on a runbook page vanished,
 *     leaving only the leaked `ac:parameter` values as stray prose.
 *   - Tables emitted no header delimiter row, so the output was not a table by
 *     any parser's reckoning and column/value association was lost.
 *   - `<ac:link>` carries its target in `<ri:page ri:content-title>` with no
 *     `href` at all, so both the link text and its target disappeared.
 *
 * `recognizeSelfClosing` matters as much as the handlers: `<ri:page .../>` is
 * an unknown tag, and without it every following sibling nests inside a tag
 * that never closes.
 *
 * Link targets are emitted as `confluence://` URIs. They are deliberately not
 * resolvable ids — mapping a page title to a canonical id needs a title index
 * and is a separate change — but they keep the target addressable instead of
 * discarded, and they cannot collide with the absolute-URL patterns that
 * ingest/common.ts scrapes for graph edges.
 */

import { Parser } from "htmlparser2";

const HEADINGS: Record<string, string> = {
  h1: "#",
  h2: "##",
  h3: "###",
  h4: "####",
  h5: "#####",
  h6: "######",
};
const SKIP = new Set(["script", "style"]);

/** Macros rendered as a blockquote callout, keyed by the ac:name attribute. */
const PANEL_MACROS = new Set(["info", "note", "warning", "tip", "panel", "expand"]);
/** Macros whose plain-text body is reproduced verbatim inside a fence. */
const VERBATIM_MACROS = new Set(["code", "noformat"]);

/** How a capture buffer treats the text pushed into it. */
type CaptureMode =
  /** Byte-for-byte; whitespace is content (code macro bodies). */
  | "raw"
  /** Collapse runs of whitespace to one space (table cells, link bodies). */
  | "inline"
  /** Nested markdown, re-emitted with a prefix (panels, blockquotes). */
  | "block";

interface Capture {
  mode: CaptureMode;
  parts: string[];
}

interface MacroFrame {
  name: string;
  language: string | null;
}

interface LinkFrame {
  target: string | null;
  /** Human title from the ri: element, used as link text when no body is given. */
  label: string | null;
  body: string | null;
}

/**
 * Confluence addresses pages by TITLE, and the title is the only searchable
 * thing about the target. Percent-encoding it would put `Retry%20Policy` in the
 * body, which no lexical arm can match — so the destination keeps its literal
 * text and is wrapped in the angle-bracket form GFM provides for exactly this.
 * Only the characters that would terminate that form are escaped.
 */
function linkTarget(kind: string, parts: string[]): string {
  const path = parts.map((p) => p.replace(/[<>\n\r]/g, " ").trim()).join("/");
  return `<confluence://${kind}/${path}>`;
}

interface TableRow {
  cells: string[];
  isHeader: boolean;
}

/** Table cells are single-line: fold newlines and neutralise column separators. */
function cellText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function renderTable(rows: TableRow[]): string {
  const filled = rows.filter((r) => r.cells.length > 0);
  if (filled.length === 0) return "";
  const width = Math.max(...filled.map((r) => r.cells.length));
  const pad = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < width) padded.push("");
    return `| ${padded.join(" | ")} |`;
  };
  // GFM requires a header. When a table has no `th` at all the first row is
  // promoted, which is what every markdown converter does and what keeps the
  // column count honest — a blank header row buys nothing and costs a row of
  // meaning.
  const [header, ...rest] = filled;
  const lines = [pad(header!.cells), `|${" --- |".repeat(width)}`];
  for (const r of rest) lines.push(pad(r.cells));
  return `\n\n${lines.join("\n")}\n\n`;
}

/** Prefix every line of an already-rendered block, for callouts and quotes. */
function quote(block: string): string {
  const body = block.trim();
  if (!body) return "";
  const lines = body.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
  return `\n\n${lines.join("\n")}\n\n`;
}

export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const captures: Capture[] = [];
  const listStack: Array<"ul" | "ol"> = [];
  const olCounters: number[] = [];
  const macroStack: MacroFrame[] = [];
  const linkStack: LinkFrame[] = [];
  let inPre = false;
  let skipDepth = 0;
  let href: string | null = null;
  let paramName: string | null = null;
  let imageDepth = 0;

  // Table state. Only the outermost table is rendered as a table; markdown has
  // no nested-table form, so inner ones flatten into the enclosing cell.
  let tableDepth = 0;
  let rows: TableRow[] = [];
  let row: TableRow | null = null;

  const emit = (text: string) => {
    const top = captures[captures.length - 1];
    if (top) top.parts.push(text);
    else out.push(text);
  };
  const capture = (mode: CaptureMode) => captures.push({ mode, parts: [] });
  const release = (): string => (captures.pop()?.parts ?? []).join("");

  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        if (SKIP.has(tag)) {
          skipDepth += 1;
          return;
        }

        // --- Confluence macro vocabulary ------------------------------------
        if (tag === "ac:structured-macro") {
          macroStack.push({ name: attrs["ac:name"] ?? "", language: null });
          return;
        }
        if (tag === "ac:parameter") {
          paramName = attrs["ac:name"] ?? "";
          capture("inline"); // held for the macro frame, never emitted as prose
          return;
        }
        if (tag === "ac:plain-text-body") {
          capture("raw");
          return;
        }
        if (tag === "ac:rich-text-body") {
          const macro = macroStack[macroStack.length - 1];
          if (macro && PANEL_MACROS.has(macro.name)) capture("block");
          return;
        }
        if (tag === "ac:link") {
          linkStack.push({ target: null, label: null, body: null });
          return;
        }
        if (tag === "ac:plain-text-link-body" || tag === "ac:link-body") {
          capture("inline");
          return;
        }
        if (tag === "ac:image") {
          imageDepth += 1;
          return;
        }
        if (tag === "ri:page") {
          const title = attrs["ri:content-title"];
          if (title) {
            const space = attrs["ri:space-key"];
            const uri = linkTarget("page", space ? [space, title] : [title]);
            const link = linkStack[linkStack.length - 1];
            if (link) {
              link.target = uri;
              link.label = title;
            } else emit(`[${title}](${uri})`);
          }
          return;
        }
        if (tag === "ri:attachment") {
          const file = attrs["ri:filename"];
          if (file) {
            const uri = linkTarget("attachment", [file]);
            const link = linkStack[linkStack.length - 1];
            if (link) {
              link.target = uri;
              link.label = file;
            } else emit(`${imageDepth > 0 ? "!" : ""}[${file}](${uri})`);
          }
          return;
        }
        if (tag === "ri:user") {
          const user = attrs["ri:username"] ?? attrs["ri:userkey"];
          if (user) {
            const link = linkStack[linkStack.length - 1];
            if (link) link.label ??= `@${user}`;
            else emit(`@${user}`);
          }
          return;
        }

        // --- Tables -----------------------------------------------------------
        if (tag === "table") {
          tableDepth += 1;
          if (tableDepth === 1) {
            rows = [];
            row = null;
          }
          return;
        }
        if (tableDepth === 1 && (tag === "tr" || tag === "td" || tag === "th")) {
          if (tag === "tr") row = { cells: [], isHeader: false };
          else {
            if (tag === "th" && row) row.isHeader = true;
            capture("inline");
          }
          return;
        }
        if (tableDepth > 0 && (tag === "tbody" || tag === "thead" || tag === "tfoot")) return;

        // --- Plain HTML -------------------------------------------------------
        if (tag in HEADINGS) emit(`\n\n${HEADINGS[tag]} `);
        else if (tag === "p") emit("\n\n");
        else if (tag === "br") emit("\n");
        else if (tag === "hr") emit("\n\n---\n\n");
        else if (tag === "blockquote") capture("block");
        else if (tag === "ul" || tag === "ol") {
          listStack.push(tag);
          olCounters.push(0);
        } else if (tag === "li") {
          const indent = "  ".repeat(Math.max(0, listStack.length - 1));
          if (listStack[listStack.length - 1] === "ol") {
            olCounters[olCounters.length - 1]! += 1;
            emit(`\n${indent}${olCounters[olCounters.length - 1]}. `);
          } else {
            emit(`\n${indent}- `);
          }
        } else if (tag === "pre") {
          inPre = true;
          emit("\n\n```\n");
        } else if (tag === "code" && !inPre) emit("`");
        else if (tag === "strong" || tag === "b") emit("**");
        else if (tag === "em" || tag === "i") emit("*");
        else if (tag === "a") {
          href = attrs.href ?? null;
          emit("[");
        } else if (tag === "img") {
          if (attrs.src) emit(`![${attrs.alt ?? ""}](${attrs.src})`);
        }
      },

      onclosetag(tag) {
        if (SKIP.has(tag)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }

        if (tag === "ac:structured-macro") {
          macroStack.pop();
          return;
        }
        if (tag === "ac:parameter") {
          const value = release().trim();
          const macro = macroStack[macroStack.length - 1];
          // `language` selects the fence info string; every other parameter is
          // macro configuration and must not reach the body as prose.
          if (macro && paramName === "language" && value) macro.language = value;
          paramName = null;
          return;
        }
        if (tag === "ac:plain-text-body") {
          const body = release();
          const macro = macroStack[macroStack.length - 1];
          if (macro && VERBATIM_MACROS.has(macro.name)) {
            emit(`\n\n\`\`\`${macro.language ?? ""}\n${body.replace(/\n+$/, "")}\n\`\`\`\n\n`);
          } else {
            emit(body);
          }
          return;
        }
        if (tag === "ac:rich-text-body") {
          const macro = macroStack[macroStack.length - 1];
          if (macro && PANEL_MACROS.has(macro.name)) emit(quote(release()));
          return;
        }
        if (tag === "ac:link") {
          const link = linkStack.pop();
          if (link) {
            const text = link.body?.trim() || link.label || "";
            if (link.target && text) emit(`[${text}](${link.target})`);
            else if (text) emit(text);
          }
          return;
        }
        if (tag === "ac:plain-text-link-body" || tag === "ac:link-body") {
          const body = release();
          const link = linkStack[linkStack.length - 1];
          if (link) link.body = body;
          else emit(body);
          return;
        }
        if (tag === "ac:image") {
          imageDepth = Math.max(0, imageDepth - 1);
          return;
        }
        if (tag === "ri:page" || tag === "ri:attachment" || tag === "ri:user") return;

        // --- Tables -----------------------------------------------------------
        if (tag === "table") {
          if (tableDepth === 1) {
            if (row) {
              rows.push(row);
              row = null;
            }
            emit(renderTable(rows));
            rows = [];
          }
          tableDepth = Math.max(0, tableDepth - 1);
          return;
        }
        if (tableDepth === 1 && (tag === "tr" || tag === "td" || tag === "th")) {
          if (tag === "tr") {
            if (row) rows.push(row);
            row = null;
          } else if (row) {
            row.cells.push(cellText(release()));
          } else {
            release(); // cell outside a row: drop rather than corrupt the grid
          }
          return;
        }
        if (tableDepth > 0 && (tag === "tbody" || tag === "thead" || tag === "tfoot")) return;

        // --- Plain HTML -------------------------------------------------------
        if (tag in HEADINGS || tag === "p") emit("\n");
        else if (tag === "blockquote") emit(quote(release()));
        else if (tag === "ul" || tag === "ol") {
          if (listStack.length > 0) {
            listStack.pop();
            olCounters.pop();
          }
          emit("\n");
        } else if (tag === "pre") {
          inPre = false;
          emit("\n```\n");
        } else if (tag === "code" && !inPre) emit("`");
        else if (tag === "strong" || tag === "b") emit("**");
        else if (tag === "em" || tag === "i") emit("*");
        else if (tag === "a") {
          emit(href ? `](${href})` : "]");
          href = null;
        }
      },

      ontext(data) {
        if (skipDepth > 0) return;
        const top = captures[captures.length - 1];
        // Raw captures are code: whitespace there is content, not formatting.
        if (top?.mode === "raw" || inPre) emit(data);
        else emit(data.replace(/\s+/g, " "));
      },
    },
    // recognizeCDATA: a code macro's body is a CDATA section, and without this
    // it is parsed as a bogus comment and dropped entirely.
    // recognizeSelfClosing: `<ri:page .../>` is an unknown tag, so without this
    // it never closes and every following sibling nests inside it.
    { decodeEntities: true, recognizeCDATA: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();

  let text = out.join("");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
