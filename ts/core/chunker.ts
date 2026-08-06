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

/**
 * Sections, each with the 1-based line range it came from.
 *
 * The line numbers are tracked here rather than recovered later because a
 * section's text is trimmed and joined — by the time it is a string, the offset
 * back into the original document is gone. Byte-compatible with the previous
 * implementation: the breadcrumb and text produced are identical, and the goldens
 * under tests/golden/ remain the contract.
 */
interface Section {
  breadcrumb: string;
  text: string;
  /** 1-based inclusive, over the ORIGINAL body. */
  lineStart: number;
  lineEnd: number;
}

function sections(body: string, root: string[]): Section[] {
  const stack: Array<[number, string]> = [];
  const out: Array<{ bc: string; lines: string[]; start: number }> = [];
  let current: string[] = [];

  const breadcrumb = () => [...root, ...stack.map(([, t]) => t)].join(" > ");

  out.push({ bc: breadcrumb(), lines: current, start: 1 });
  let lineNo = 0;
  for (const line of body.split("\n")) {
    lineNo += 1;
    const m = HEADING_RE.exec(line);
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]![0] >= level) stack.pop();
      stack.push([level, title]);
      current = [];
      // The section starts on the line AFTER its heading.
      out.push({ bc: breadcrumb(), lines: current, start: lineNo + 1 });
    } else {
      current.push(line);
    }
  }
  return out
    .map(({ bc, lines, start }): Section => {
      // `.trim()` on the joined string is kept verbatim, so the emitted text —
      // and therefore every golden and every chunk hash — is byte-identical.
      // Line attribution is computed separately, from which LINES actually
      // carry content, so leading and trailing blank lines do not shift or
      // inflate the reported range.
      const first = lines.findIndex((l) => l.trim().length > 0);
      const lastRel = [...lines].reverse().findIndex((l) => l.trim().length > 0);
      const last = lastRel === -1 ? -1 : lines.length - 1 - lastRel;
      return {
        breadcrumb: bc,
        text: lines.join("\n").trim(),
        lineStart: first === -1 ? start : start + first,
        lineEnd: last === -1 ? start : start + last,
      };
    })
    .filter((s) => s.text.length > 0);
}

/** A packed piece, with the source lines it actually came from. */
interface Piece {
  text: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Split an oversized section on paragraph boundaries, hard-wrapping only as a
 * last resort — carrying line provenance THROUGH the split.
 *
 * Provenance is tracked here rather than recovered afterwards by searching for
 * each piece in the section text. That search is only correct while every piece
 * happens to be a literal substring of the source, which is an accident of how
 * paragraphs are rejoined: an empty paragraph (from three or more consecutive
 * newlines) interacting with a hard-wrap flush already produces a piece that is
 * not findable, and the miss degrades silently to the whole-section range — the
 * imprecision this exists to remove. Computing spans from the paragraphs
 * themselves cannot drift from how they are reassembled.
 *
 * `text` values are byte-identical to the previous implementation, so goldens
 * and chunk hashes are untouched.
 */
function pack(text: string, baseLine: number): Piece[] {
  if (text.length <= MAX_CHARS)
    return [{ text, lineStart: baseLine, lineEnd: baseLine + countNewlines(text) }];

  // Paragraph boundaries, with each paragraph's absolute line span. The "\n\n"
  // separator itself accounts for exactly two newlines.
  const paras: Piece[] = [];
  let line = baseLine;
  for (const para of text.split("\n\n")) {
    const nl = countNewlines(para);
    paras.push({ text: para, lineStart: line, lineEnd: line + nl });
    line += nl + 2;
  }

  const parts: Piece[] = [];
  let buf: Piece | null = null;
  for (const para of paras) {
    let rest = para;
    while (rest.text.length > MAX_CHARS) {
      const head = rest.text.slice(0, MAX_CHARS);
      const headEnd = rest.lineStart + countNewlines(head);
      parts.push({ text: head, lineStart: rest.lineStart, lineEnd: headEnd });
      // A hard wrap can land mid-line, so the remainder CONTINUES on the line
      // the head ended on — which is why a single wrapped line honestly reports
      // that same line for every slice cut from it.
      rest = { text: rest.text.slice(MAX_CHARS), lineStart: headEnd, lineEnd: rest.lineEnd };
    }
    if (buf && buf.text.length + rest.text.length + 2 > MAX_CHARS) {
      parts.push(buf);
      buf = rest;
    } else if (buf) {
      buf = {
        text: `${buf.text}\n\n${rest.text}`,
        lineStart: buf.lineStart,
        lineEnd: rest.lineEnd,
      };
    } else {
      buf = rest;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

const countNewlines = (t: string): number => {
  let n = 0;
  for (let i = 0; i < t.length; i++) if (t[i] === "\n") n++;
  return n;
};

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
  for (const section of sections(doc.body, [doc.title])) {
    for (const piece of pack(section.text, section.lineStart)) {
      chunks.push({
        docId: doc.id,
        seq: chunks.length,
        headingPath: section.breadcrumb,
        text: piece.text,
        // The PIECE's own span, carried out of `pack` rather than recovered
        // afterwards, so it cannot drift from how paragraphs were reassembled.
        //
        // Attached only when the document carries a real path, and never
        // derived from the id: an explicit frontmatter id makes identity
        // independent of the path, so the two can legitimately disagree.
        ...(doc.sourcePath
          ? { sourcePath: doc.sourcePath, lineStart: piece.lineStart, lineEnd: piece.lineEnd }
          : {}),
      });
    }
  }
  return chunks;
}
