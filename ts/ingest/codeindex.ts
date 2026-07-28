export type CodeIndexKind = "path" | "symbol" | "literal" | "import" | "export" | "test";
export interface CodeIndexEntry {
  kind: CodeIndexKind;
  value: string;
  rawValue: string;
  lineStart: number;
  lineEnd: number;
  symbolKind?: string;
  language: string;
  extractorVersion: string;
}
export const EXTRACTOR_VERSION = "regex-v1";

/**
 * `value` is part of code_index's primary key, and a btree key tops out at 2704
 * bytes. An incompressible literal past that limit — a base64 blob, a data URI,
 * a minified JS or CSS line, an embedded certificate — made the INSERT raise
 * "index row size exceeds btree maximum" and aborted the whole repo ingest with
 * the cursor unadvanced, so every retry failed at the same file and the repo
 * could never be ingested. Measured: 26 of 111 supported-language files in this
 * very repo (23.4%) hit it. Nothing over this length is a searchable identifier.
 */
export const MAX_INDEX_VALUE_CHARS = 256;
export function detectLanguage(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop();
  return (
    (
      {
        ts: "typescript",
        tsx: "tsx",
        js: "javascript",
        jsx: "jsx",
        py: "python",
        go: "go",
        rs: "rust",
      } as Record<string, string>
    )[ext ?? ""] ?? null
  );
}
const add = (
  out: CodeIndexEntry[],
  kind: CodeIndexKind,
  raw: string,
  line: number,
  language: string,
  symbolKind?: string,
) => {
  if (raw.length > MAX_INDEX_VALUE_CHARS) return;
  out.push({
    kind,
    value: raw.toLowerCase(),
    rawValue: raw,
    lineStart: line,
    lineEnd: line,
    ...(symbolKind ? { symbolKind } : {}),
    language,
    extractorVersion: EXTRACTOR_VERSION,
  });
};
export function extractCodeIndex(path: string, content: string): CodeIndexEntry[] {
  const language = detectLanguage(path);
  if (!language) return [];
  const out: CodeIndexEntry[] = [];
  add(out, "path", path, 1, language);
  const testPath = /(^|\/)(__tests__\/|.*\.(test|spec)\.)/.test(path);
  for (const [i, line] of content.split("\n").entries()) {
    const n = i + 1;
    for (const m of line.matchAll(
      /\b(?:function|class|interface|type|const|let|var|def|func|struct|enum)\s+([A-Za-z_$][\w$]*)/g,
    ))
      add(out, "symbol", m[1]!, n, language, m[0]!.split(/\s+/)[0]);
    for (const m of line.matchAll(
      /\bimport\s+(?:.+?\s+from\s+)?["']([^"']+)["']|\brequire\(["']([^"']+)["']\)/g,
    ))
      add(out, "import", m[1] ?? m[2]!, n, language);
    if (/\bexport\b/.test(line)) add(out, "export", line.trim(), n, language);
    for (const m of line.matchAll(/["']([^"']{2,})["']/g)) add(out, "literal", m[1]!, n, language);
    if (testPath || /\b(describe|it|test|pytest|Test[A-Z])\s*\(?/.test(line))
      add(out, "test", path, n, language);
  }
  return out;
}
