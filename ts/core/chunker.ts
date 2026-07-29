/**
 * Structure-aware markdown chunker.
 *
 * Deterministic by construction and byte-compatible with the original
 * implementation: the golden files under tests/golden/ are the contract —
 * the TS port must reproduce them exactly.
 */

import type { CanonicalDoc, Chunk } from "../contracts/models.js";

/** ~400–800 tokens at the usual ~4 chars/token. */
export const MAX_CHARS = 3200;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function sections(body: string, root: string[]): Array<[string, string]> {
  const stack: Array<[number, string]> = [];
  const out: Array<[string, string[]]> = [];
  let current: string[] = [];

  const breadcrumb = () => [...root, ...stack.map(([, t]) => t)].join(" > ");

  out.push([breadcrumb(), current]);
  for (const line of body.split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]![0] >= level) stack.pop();
      stack.push([level, title]);
      current = [];
      out.push([breadcrumb(), current]);
    } else {
      current.push(line);
    }
  }
  return out
    .map(([bc, lines]): [string, string] => [bc, lines.join("\n").trim()])
    .filter(([, text]) => text.length > 0);
}

/** Split an oversized section on paragraph boundaries, hard-wrapping only as a last resort. */
function pack(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const parts: string[] = [];
  let buf = "";
  for (let para of text.split("\n\n")) {
    while (para.length > MAX_CHARS) {
      parts.push(para.slice(0, MAX_CHARS));
      para = para.slice(MAX_CHARS);
    }
    if (buf && buf.length + para.length + 2 > MAX_CHARS) {
      parts.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

export const CODE_WINDOW_LINES = 60;
export const CODE_OVERLAP_LINES = 10;

/** Deterministic line-window chunker for code: fixed windows with overlap,
 *  line ranges preserved in the heading for citation. */
export function chunkCode(doc: CanonicalDoc): Chunk[] {
  const lines = doc.body.split("\n");
  const chunks: Chunk[] = [];
  const step = CODE_WINDOW_LINES - CODE_OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CODE_WINDOW_LINES, lines.length);
    const headingPath = `${doc.title} › L${start + 1}-${end}`;
    const window = lines.slice(start, end).join("\n");
    chunks.push({
      docId: doc.id,
      seq: chunks.length,
      headingPath,
      text: window,
    });
    if (end === lines.length) break;
  }
  return chunks;
}

export function chunk(doc: CanonicalDoc): Chunk[] {
  if (doc.source === "code") return chunkCode(doc);
  const chunks: Chunk[] = [];
  for (const [headingPath, text] of sections(doc.body, [doc.title])) {
    for (const piece of pack(text)) {
      chunks.push({
        docId: doc.id,
        seq: chunks.length,
        headingPath,
        text: piece,
      });
    }
  }
  return chunks;
}
