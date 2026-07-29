/**
 * Secret detection at ingest.
 *
 * EIL's premise is feeding org knowledge to LLMs, so an indexed credential is
 * not a latent risk — it is a credential handed to an agent. Every
 * `.env.example`, committed `.pem`, and Confluence page holding production
 * credentials was previously indexed verbatim and served through get_doc.
 *
 * The policy is detect -> quarantine -> redact-on-serve, and the load-bearing
 * detail lives in store.ts rather than here: **a quarantined document is never
 * chunked or embedded**. Redacting only on serve would have been insufficient,
 * because the secret also flows body -> chunks.text -> tsv, and a tsvector is
 * searchable — an attacker could confirm an API key exists by searching a
 * fragment of it and seeing a hit. Skipping chunk+embed closes the tsv, the
 * ts_headline snippet, the vector-arm snippet and the embedding at once, and is
 * cheaper than redacting each.
 *
 * The original body is retained. Destroying it would make a false positive
 * unrecoverable, and the remediation workflow needs to show what was found.
 */

export interface SecretFinding {
  /** rule that matched, e.g. "aws-access-key-id" */
  rule: string;
  /** byte offsets into the body, so get_doc can redact without re-scanning */
  start: number;
  end: number;
  /** first + last 4 chars only — enough to locate it at the source, not to use it */
  hint: string;
}

interface Rule {
  name: string;
  re: RegExp;
  /** which capture group holds the secret; 0 = whole match */
  group?: number;
}

/**
 * Shape-based rules first: they are near-zero false positive because the
 * prefixes are registered and unambiguous. Entropy is applied afterwards and
 * only to assignment-like contexts, because entropy alone flags every hash,
 * UUID and base64 asset in a repo.
 */
const RULES: Rule[] = [
  {
    name: "aws-access-key-id",
    re: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16})\b/g,
    group: 1,
  },
  { name: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g, group: 1 },
  { name: "slack-token", re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { name: "google-api-key", re: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  { name: "stripe-key", re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g, group: 1 },
  { name: "openai-key", re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/g, group: 1 },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "jwt",
    re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    group: 1,
  },
  // A password embedded in a connection string is a real credential, and the
  // shape is unambiguous enough not to need entropy.
  {
    name: "connection-string-password",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s:@/]{6,})@/gi,
    group: 1,
  },
];

/** `TOKEN = "..."` / `api_key: '...'` — the only context entropy is trusted in. */
const ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credential|apikey)[A-Za-z0-9_.-]*)\s*[:=]\s*["']([^"'\s]{16,})["']/gi;

/** Shannon entropy in bits/char. Random base64 ≈ 5.5+; English prose ≈ 3.5–4. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Entropy is a WEAK secondary signal and is deliberately not load-bearing.
 * Measured over realistic candidates (no-space, since that is all the
 * assignment regex can capture):
 *
 *   secret-like   5.00 kJ8xQ2mZ… · 4.09 S3cr3t!Passw0rd#2024$xY
 *                 3.68 AKIAIOSFODNN7EXAMPLE · 3.39 an md5 · 2.72 ghp_…
 *   benign-like   3.85 postgres_production_readonly · 3.85 REPLACE_WITH_YOUR_TOKEN
 *                 3.64 my-service-account-name · 3.36 correcthorsebatterystaple
 *
 * The distributions OVERLAP — lowest secret 2.72, highest benign 3.85 — so no
 * threshold separates them. Note the low-entropy secrets are exactly the ones
 * the shape rules already catch by prefix, which is why those come first and
 * carry the weight. This gate sits just above the benign ceiling and only fires
 * inside an assignment whose *name* says key/token/secret/password; the variable
 * name is the real signal, entropy just suppresses obvious non-values.
 */
const ENTROPY_MIN = 4.0;

/** Obvious non-secrets that satisfy both the assignment shape and the entropy bar. */
const PLACEHOLDER =
  /^(?:x{6,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|your[_-]?\w+|change[_-]?me|placeholder|example|redacted|dummy|test|todo|none|null|nil|n\/a)$/i;

const hintOf = (s: string) =>
  s.length <= 12 ? `${s.slice(0, 2)}…` : `${s.slice(0, 4)}…${s.slice(-4)}`;

/** Findings sorted by position, non-overlapping — get_doc redacts by walking them. */
export function scanSecrets(body: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of body.matchAll(rule.re)) {
      const g = rule.group ?? 0;
      const val = m[g];
      if (val === undefined || m.index === undefined) continue;
      const start = m.index + (g === 0 ? 0 : m[0].indexOf(val));
      out.push({ rule: rule.name, start, end: start + val.length, hint: hintOf(val) });
    }
  }
  ASSIGNMENT.lastIndex = 0;
  for (const m of body.matchAll(ASSIGNMENT)) {
    const val = m[2];
    if (val === undefined || m.index === undefined) continue;
    if (PLACEHOLDER.test(val)) continue;
    if (entropy(val) < ENTROPY_MIN) continue;
    const start = m.index + m[0].lastIndexOf(val);
    out.push({
      rule: "high-entropy-assignment",
      start,
      end: start + val.length,
      hint: hintOf(val),
    });
  }
  // Deduplicate overlaps — a JWT inside an assignment matches both rules, and a
  // caller redacting spans must not have to reason about nesting.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretFinding[] = [];
  for (const f of out) {
    const last = merged[merged.length - 1];
    if (last && f.start < last.end) {
      if (f.end > last.end) last.end = f.end;
      continue;
    }
    merged.push({ ...f });
  }
  return merged;
}

/**
 * Identity of a finding for review purposes: the rule that matched and a hint at
 * the value, NOT its offset. Offsets shift when unrelated text is edited above
 * them, and an acceptance that evaporates on every edit is not an acceptance.
 */
export const findingKey = (f: Pick<SecretFinding, "rule" | "hint">): string =>
  `${f.rule}:${f.hint}`;

/**
 * Findings that have not been reviewed and accepted.
 *
 * Acceptance is per FINDING, not per document: if a reviewed file later gains a
 * different credential, that finding's hint differs, it is unaccepted, and the
 * document is quarantined again. Accepting one cannot silently accept the next.
 */
export function unacceptedFindings(
  findings: readonly SecretFinding[],
  accepted: ReadonlyArray<Pick<SecretFinding, "rule" | "hint">> = [],
): SecretFinding[] {
  if (accepted.length === 0) return [...findings];
  const ok = new Set(accepted.map(findingKey));
  return findings.filter((f) => !ok.has(findingKey(f)));
}

/** Replace each finding with a marker naming the rule, for get_doc. */
export function redact(body: string, findings: SecretFinding[]): string {
  if (findings.length === 0) return body;
  let out = "";
  let at = 0;
  for (const f of findings) {
    out += `${body.slice(at, f.start)}[redacted:${f.rule}]`;
    at = f.end;
  }
  return out + body.slice(at);
}
