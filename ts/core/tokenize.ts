/**
 * Identifier tokenization — ONE function, used at index time and query time.
 *
 * Asymmetry between the two is the classic silent failure in code search: the
 * index holds tokens the query can never produce, and nothing errors. So this
 * module exports a single entry point, and a test asserts both callers use it.
 *
 * Why it is needed at all, measured against the vendored Postgres:
 *   to_tsvector('english', 'retryHandler')  ->  'retryhandl'   (stemmed!)
 *   to_tsvector('simple',  'retryHandler')  ->  'retryhandler' (one opaque token)
 * so `handler` finds neither, and `src/retry/scheduler.py` is a single token that
 * `scheduler.py` cannot match.
 *
 * The rules below are NOT Lucene's WordDelimiterGraphFilter, which is the
 * obvious thing to copy and is wrong for code. Implemented exactly, Lucene
 * yields `parseHTTPResponse -> [parse, HTTPResponse]` (acronym not split) and
 * `OAuth2Client -> [O, Auth2, Client]` (split in the wrong place). Requiring TWO
 * uppercase before an acronym boundary fixes both.
 */

/** `HTTPResponse` -> `HTTP|Response`. Two uppercase required, so `OAuth2` survives. */
const ACRONYM = /(?<=[A-Z]{2})(?=[A-Z][a-z])/;
/** `retryHandler` -> `retry|Handler`. */
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])/;
/** `sha256` -> `sha|256`, emitted ADDITIVELY so the joined form survives too. */
const DIGIT = /(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;

const MIN_TOKEN = 2;

/** Sub-parts of one identifier: camel humps, acronyms, digit runs. Lowercased. */
export function subtokens(identifier: string): string[] {
  const out: string[] = [];
  for (const run of identifier.split(/[^A-Za-z0-9]+/)) {
    if (!run) continue;
    for (const acro of run.split(ACRONYM)) {
      for (const part of acro.split(CAMEL)) {
        out.push(part);
        // Additive, not replacing: `sha256Hash` should match BOTH `sha256` and
        // `sha`/`256`, because callers write it either way.
        const digits = part.split(DIGIT);
        if (digits.length > 1) out.push(...digits);
      }
    }
  }
  return dedupe(out.map((t) => t.toLowerCase()).filter((t) => t.length >= MIN_TOKEN));
}

/**
 * Every form of an identifier worth indexing: the whole thing plus its parts.
 * `retryHandler` -> `retryhandler`, `retry`, `handler`.
 */
export function tokenize(identifier: string): string[] {
  const whole = identifier.toLowerCase();
  return dedupe([...(whole.length >= MIN_TOKEN ? [whole] : []), ...subtokens(identifier)]);
}

/**
 * Path forms. Every SUFFIX is indexed, which is what makes `scheduler.py` find
 * `src/retry/scheduler.py` — the single most common code query shape that the
 * opaque-token behaviour broke.
 */
export function pathTokens(path: string): string[] {
  const clean = path.replace(/^\/+/, "");
  const segs = clean.split("/").filter(Boolean);
  const out: string[] = [clean.toLowerCase()];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(i).join("/").toLowerCase());
  for (const s of segs) out.push(s.toLowerCase());
  const base = segs[segs.length - 1] ?? "";
  if (base) {
    out.push(base.toLowerCase());
    const noExt = base.replace(/\.[^.]+$/, "");
    if (noExt) out.push(noExt.toLowerCase());
  }
  out.push(...subtokens(clean));
  return dedupe(out.filter((t) => t.length >= MIN_TOKEN));
}

/**
 * The bag of tokens for a chunk of code, as a space-joined string for
 * `to_tsvector('simple', ...)`.
 *
 * `simple` rather than `english` is a one-word change with two measured effects:
 * it stops stemming `retryHandler` into `retryhandl`, and it stops deleting
 * `if`, `for`, `do`, `no`, `on`, `is`, `t`, `s` — all real code tokens that the
 * English stopword list removes.
 */
export function codeTokens(path: string, text: string): string {
  const out = new Set<string>(pathTokens(path));
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    for (const t of tokenize(m[0])) out.add(t);
  }
  return [...out].join(" ");
}

/** Query-side: the same function, so index and query can never disagree. */
export function queryTokens(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/[A-Za-z0-9_$./-]+/g)) {
    const raw = m[0]!;
    if (raw.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(raw)) {
      for (const t of pathTokens(raw)) out.add(t);
    }
    for (const t of tokenize(raw)) out.add(t);
  }
  return [...out];
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
