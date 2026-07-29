/**
 * Recognising a Jira issue key.
 *
 * `\b([A-Z][A-Z0-9]{1,9}-\d+)\b` is structurally correct and practically wrong:
 * measured against ordinary technical text it matched 10 of 15 samples that are
 * not tickets — UTF-8, SHA-256, ISO-8601, AES-256, HTTP-2, RFC-7231, SHA-1,
 * BASE-64, IPV-4, and CVE-2021-44228 (as "CVE-2021").
 *
 * That was already polluting `links` and inflating links_dangling_dst. It is
 * about to matter much more, because code ingest starts extracting links from
 * source files, where these tokens are dense. It also affects RETRIEVAL: the
 * router uses the same shape, so searching "UTF-8 encoding" routed to the entity
 * executor and performed a Jira lookup for a ticket that cannot exist, instead
 * of searching.
 *
 * No purely structural rule can separate `OAUTH-2` from `PAY-981` — they are the
 * same shape. So this is a deny-list of standards and encodings, which is honest
 * about being a heuristic. The principled version is an ALLOW-list built from
 * the project keys actually ingested (EIL knows them: `eil ingest jira --project
 * PAY`), and `isTicketKey` takes an optional set so a caller who knows can be
 * exact. When that set is supplied the deny-list is not consulted at all.
 */

/** Prefixes that appear as PREFIX-NUMBER in technical prose and never as tickets. */
const NOT_PROJECTS = new Set([
  // hashes and crypto
  "SHA",
  "MD",
  "RSA",
  "DSA",
  "ECDSA",
  "AES",
  "DES",
  "HMAC",
  "PBKDF",
  "CRC",
  "BLAKE",
  // encodings and charsets
  "UTF",
  "UCS",
  "ASCII",
  "LATIN",
  "ISO",
  "CP",
  "BASE",
  "GB",
  "BIG",
  // protocols and standards bodies
  "HTTP",
  "HTTPS",
  "TLS",
  "SSL",
  "SSH",
  "FTP",
  "SMTP",
  "IMAP",
  "TCP",
  "UDP",
  "IP",
  "IPV",
  "RFC",
  "IEEE",
  "ANSI",
  "NIST",
  "FIPS",
  "PKCS",
  "ECMA",
  "JSR",
  "PEP",
  "DIN",
  "EN",
  // vulnerability and advisory identifiers
  "CVE",
  "CWE",
  "GHSA",
  "CAPEC",
  "OWASP",
  // auth and format acronyms
  "OAUTH",
  "SAML",
  "JWT",
  "JWE",
  "JWS",
  "OIDC",
  "LDAP",
  // misc versioned technologies
  "ES",
  "CSS",
  "HTML",
  "XHTML",
  "SQL",
  "USB",
  "PCI",
  "ARM",
  "X",
  "H",
  "MP",
  "AV",
]);

/** Structural shape only — callers must still pass it through isTicketKey(). */
export const TICKET_SHAPE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
export const TICKET_SHAPE_G = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/**
 * @param projectKeys when supplied, the exact set of real project keys; the
 *        deny-list heuristic is then bypassed entirely.
 */
export function isTicketKey(token: string, projectKeys?: ReadonlySet<string>): boolean {
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/.exec(token);
  if (!m) return false;
  const prefix = m[1]!;
  if (projectKeys) return projectKeys.has(prefix);
  return !NOT_PROJECTS.has(prefix);
}

/** Every ticket key in a body, deduped, in first-seen order. */
export function ticketKeys(body: string, projectKeys?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(TICKET_SHAPE_G)) {
    const key = m[1]!;
    if (seen.has(key) || !isTicketKey(key, projectKeys)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
