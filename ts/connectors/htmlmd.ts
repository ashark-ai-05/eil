/**
 * Confluence storage-format (XHTML) -> markdown, deterministically.
 * Port of the original SAX-style converter (htmlparser2 supplies the events);
 * behavior is pinned by the shared htmlmd tests. Unrenderable markup degrades
 * to text content rather than leaking.
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

export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const listStack: Array<"ul" | "ol"> = [];
  const olCounters: number[] = [];
  let inPre = false;
  let skipDepth = 0;
  let href: string | null = null;

  const emit = (text: string) => out.push(text);

  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        if (SKIP.has(tag)) {
          skipDepth += 1;
          return;
        }
        if (tag in HEADINGS) emit(`\n\n${HEADINGS[tag]} `);
        else if (tag === "p") emit("\n\n");
        else if (tag === "br") emit("\n");
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
        } else if (tag === "tr") emit("\n| ");
      },
      onclosetag(tag) {
        if (SKIP.has(tag)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (tag in HEADINGS || tag === "p") emit("\n");
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
        } else if (tag === "td" || tag === "th") emit(" | ");
      },
      ontext(data) {
        if (skipDepth > 0) return;
        emit(inPre ? data : data.replace(/\s+/g, " "));
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  let text = out.join("");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
