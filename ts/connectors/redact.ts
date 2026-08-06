/**
 * Shared URL/DSN-shaped secret redaction. Distinct in purpose from
 * `ts/ingest/secrets.ts`'s scanSecrets/redact (a pattern-based scanner over
 * ingested DOCUMENT CONTENT, for the quarantine pipeline) — this module
 * scrubs credentials that live in a URL's own shape (userinfo,
 * credential-named query parameters) or free-form transport-error prose
 * that may embed one. Originally lived inline in `ts/doctor.ts`; extracted
 * so the HTTP client's own structured errors (`ts/connectors/httperror.ts`)
 * redact through the same code doctor already used, instead of a third
 * copy drifting from both.
 */

/**
 * Query parameter names that commonly carry a credential. Matched
 * case-insensitively; separators (-, _) are optional so `api_key`,
 * `api-key` and `apikey` all match.
 */
const CREDENTIAL_QUERY_KEY_RE =
  /^(token|api[-_]?key|access[-_]?token|password|secret|auth|pat|client[-_]?secret)$/i;

/**
 * Redacts a URL for safe logging: masks all userinfo (not just user:pass —
 * a username-only form like `https://AKIA...@host` is exactly as sensitive)
 * and any credential-shaped query parameter, preserving host/path context.
 * Input that isn't a parseable URL gets a safe placeholder rather than
 * being echoed verbatim, since a malformed string can still contain a raw
 * credential a regex alone might miss the shape of.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "<unparseable-url>";
  }
  return redactUrlObject(url).toString();
}

/**
 * Same redaction as `redactUrl`, operating on an already-parsed `URL`
 * object (returned as a clone, the input is never mutated) — avoids a
 * callers round-tripping through `.toString()` + `new URL()` just to
 * redact a URL it already has parsed, which every HTTP client call site
 * does.
 */
export function redactUrlObject(url: URL): URL {
  const clone = new URL(url.toString());
  if (clone.username || clone.password) {
    clone.username = "***";
    clone.password = "";
  }
  for (const key of clone.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEY_RE.test(key)) clone.searchParams.set(key, "***");
  }
  return clone;
}

/**
 * Textual scrub for free-form error messages, which — unlike a single
 * `EIL_<PREFIX>_URL` value — aren't guaranteed to be one parseable URL; a
 * driver or fetch error can embed a credential-bearing URL inside prose.
 * Same masking rules as redactUrl, applied by pattern rather than by
 * parsing, since there is no single URL to construct a URL object from.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/:\/\/[^\s/@]+(:[^\s/@]*)?@/g, "://***@")
    .replace(
      /([?&](?:token|api[-_]?key|access[-_]?token|password|secret|auth|pat|client[-_]?secret)=)[^&\s]*/gi,
      "$1***",
    );
}
