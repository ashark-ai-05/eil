/**
 * Bounded frontmatter parsing — a deliberately small subset of YAML.
 *
 * This is NOT a YAML parser and must not become one. Full YAML carries aliases,
 * anchors, custom tags and merge keys; a document is untrusted input, and the
 * only thing EIL wants from its header is four allowlisted fields. Parsing a
 * Turing-complete-adjacent object graph to read `title:` is a strictly larger
 * attack surface than reading `title:`.
 *
 * So the grammar here is: `key: scalar`, `key: [a, b]`, and `key:` followed by
 * `- item` lines. Anything else in the frontmatter region is a REFUSAL rather
 * than a silent skip — a note whose header we cannot read unambiguously is a
 * per-item failure the coverage report can show, not a document quietly ingested
 * with its metadata dropped.
 */

/** Frontmatter beyond this is refused outright: a header is not a payload. */
export const MAX_FRONTMATTER_BYTES = 16 * 1024;
/** More keys than any legitimate header needs; bounds pathological input. */
export const MAX_FRONTMATTER_KEYS = 64;
/** Bounds a single list; `aliases` with 10k entries is not a document header. */
export const MAX_LIST_ITEMS = 64;

/**
 * The only keys projected into canonical metadata.
 *
 * An allowlist rather than a denylist: an unknown key is ignored, so a vault
 * carrying tool-specific headers ingests fine, but nothing unanticipated can
 * reach the document model.
 */
export const ALLOWED_KEYS = ["id", "title", "tags", "aliases"] as const;
export type AllowedKey = (typeof ALLOWED_KEYS)[number];

export interface Frontmatter {
  id?: string;
  title?: string;
  tags: string[];
  aliases: string[];
}

export interface FrontmatterResult {
  /** Body with the frontmatter region removed. */
  body: string;
  matter: Frontmatter;
  /** Present when the header could not be read; the caller fails the item. */
  error?: string;
}

const EMPTY: Frontmatter = { tags: [], aliases: [] };

const unquote = (raw: string): string => {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))))
    return v.slice(1, -1);
  return v;
};

const splitInline = (raw: string): string[] =>
  raw
    .slice(1, -1)
    .split(",")
    .map(unquote)
    .filter((s) => s.length > 0);

/**
 * Split a document into frontmatter and body.
 *
 * Only a header at the very first byte counts. A `---` later in the file is a
 * horizontal rule, and treating it as a header would let any document with a
 * thematic break lose its opening paragraphs.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n"))
    return { body: raw, matter: { ...EMPTY } };

  const firstLineEnd = raw.indexOf("\n") + 1;
  const rest = raw.slice(firstLineEnd);
  const closeIdx = rest.search(/^---\s*$/m);
  if (closeIdx === -1)
    // An unterminated header would otherwise swallow the whole document as
    // metadata. Refuse rather than guess where it was meant to end.
    return { body: raw, matter: { ...EMPTY }, error: "frontmatter is not terminated by ---" };

  const region = rest.slice(0, closeIdx);
  if (Buffer.byteLength(region, "utf-8") > MAX_FRONTMATTER_BYTES)
    return {
      body: raw,
      matter: { ...EMPTY },
      error: `frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`,
    };

  const afterClose = rest.slice(closeIdx);
  const bodyStart = afterClose.indexOf("\n");
  const body = bodyStart === -1 ? "" : afterClose.slice(bodyStart + 1);

  const matter: Frontmatter = { tags: [], aliases: [] };
  const lines = region.split(/\r?\n/);
  let pendingList: AllowedKey | null = null;
  let keyCount = 0;

  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    // A `- item` line belongs to the key that opened the list.
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem) {
      if (pendingList === null) continue; // list under an ignored key
      const target = matter[pendingList];
      if (Array.isArray(target)) {
        if (target.length >= MAX_LIST_ITEMS)
          return { body: raw, matter: { ...EMPTY }, error: `list ${pendingList} exceeds bounds` };
        const v = unquote(listItem[1] ?? "");
        if (v.length > 0) target.push(v);
      }
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv)
      // Nested maps, anchors, tags, multi-line scalars — everything outside the
      // subset lands here and is refused by name rather than ignored.
      return {
        body: raw,
        matter: { ...EMPTY },
        error: `unsupported frontmatter syntax: ${line.trim().slice(0, 60)}`,
      };

    if (++keyCount > MAX_FRONTMATTER_KEYS)
      return { body: raw, matter: { ...EMPTY }, error: "frontmatter has too many keys" };

    const key = kv[1] as string;
    const value = (kv[2] ?? "").trim();
    pendingList = null;
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) continue;
    const allowed = key as AllowedKey;

    if (allowed === "tags" || allowed === "aliases") {
      if (value.startsWith("[") && value.endsWith("]")) matter[allowed] = splitInline(value);
      else if (value.length === 0) pendingList = allowed;
      else matter[allowed] = [unquote(value)];
      continue;
    }
    if (value.length > 0) matter[allowed] = unquote(value);
  }

  return { body, matter };
}

/**
 * First `# ` heading OUTSIDE a fenced code block.
 *
 * The naive scan takes any line starting with `# `, so a shell comment inside a
 * fence becomes the document title — and the title is what a search result
 * shows, so it is the most visible field to get wrong.
 */
export function firstHeading(body: string): string | null {
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      if (fence === null) fence = marker[0] as string;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}
