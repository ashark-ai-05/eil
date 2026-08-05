/**
 * `eil doctor` — one preflight command answering "why won't this reach my
 * org's systems" before a corp-network first run wastes an hour on an
 * opaque timeout. Every check is loud and specific rather than a silent
 * pass/fail: docs/setup.md's corporate-network section (proxy, corp CA,
 * old-DC Basic-auth fallback) is exactly what a user has to remember today;
 * this is that section made executable.
 */

import { scopedFetch } from "./connectors/httpclient.js";
import { SOURCES, keychainBackend, resolvedSource } from "./connectors/keychain.js";
import { connect, dsn, pendingMigrations, safeDsn } from "./db.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const MIN_NODE_MAJOR = 22;

export function nodeVersionCheck(nodeVersion: string = process.version): DoctorCheck {
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    name: "node-version",
    ok,
    detail: ok
      ? `${nodeVersion} (>= ${MIN_NODE_MAJOR} required)`
      : `${nodeVersion} is below the required Node >=${MIN_NODE_MAJOR} — connectors and the MCP server are not supported on this runtime`,
  };
}

export function proxyEnvCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (!httpProxy && !httpsProxy) {
    return {
      name: "proxy-env",
      ok: true,
      detail: "no HTTP_PROXY/HTTPS_PROXY set — direct connections",
    };
  }
  const parts = [
    httpProxy ? `HTTP_PROXY=${redactUrl(httpProxy)}` : null,
    httpsProxy ? `HTTPS_PROXY=${redactUrl(httpsProxy)}` : null,
    noProxy ? `NO_PROXY=${noProxy}` : "NO_PROXY not set",
  ].filter(Boolean);
  return { name: "proxy-env", ok: true, detail: parts.join(", ") };
}

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
  if (url.username || url.password) {
    url.username = "***";
    url.password = "";
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEY_RE.test(key)) url.searchParams.set(key, "***");
  }
  return url.toString();
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

async function dbCheck(): Promise<DoctorCheck> {
  const target = safeDsn(dsn());
  let client: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    client = await connect();
    const pending = await pendingMigrations(client);
    return pending.length === 0
      ? { name: "database", ok: true, detail: `reachable, up to date (${target})` }
      : {
          name: "database",
          ok: false,
          detail: `reachable but ${pending.length} pending migration(s) — run \`eil db migrate\` (${target})`,
        };
  } catch (err: any) {
    // A driver error can echo the DSN it failed to reach, password and all —
    // safeDsn() only masks the DSN doctor itself prints, not whatever the
    // pg driver embeds in its own error message.
    const cause = scrubSecrets(String(err?.message ?? err).split("\n")[0] ?? "unknown error");
    return { name: "database", ok: false, detail: `cannot reach ${target}: ${cause}` };
  } finally {
    await client?.end().catch(() => {});
  }
}

function keychainCheck(): DoctorCheck {
  const { name, available } = keychainBackend();
  return {
    name: "keychain",
    ok: true, // absence is a fallback to env vars, not a failure — see connector-credential checks
    detail: available
      ? `backend: ${name}`
      : `backend: ${name} (unavailable — connectors will fall back to EIL_<PREFIX>_TOKEN env vars)`,
  };
}

export function connectorCredentialChecks(env: NodeJS.ProcessEnv): DoctorCheck[] {
  return Object.entries(SOURCES).map(([source, account]) => {
    // doctor never touches the keychain itself — that's a live macOS
    // Keychain/secret-tool/Credential Manager prompt on some backends, which
    // a preflight command must not trigger as a side effect of running.
    const envPresent = resolvedSource(account, env, () => null) === "env";
    return {
      name: `credential:${source}`,
      ok: true, // an unconfigured connector is not an error — just not in use
      detail: envPresent
        ? `${account} set via environment`
        : `${account} not in environment — presence unknown, the OS keychain may still supply it at connector construction time (doctor does not query the keychain itself)`,
    };
  });
}

/** Classifies a fetch failure without leaking the URL's credentials or the raw stack. */
export function classifyFetchError(err: unknown): string {
  const code = (err as any)?.cause?.code ?? (err as any)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS resolution failed";
  if (code === "ECONNREFUSED") return "connection refused";
  if (
    code === "ETIMEDOUT" ||
    (err as any)?.name === "TimeoutError" ||
    (err as any)?.name === "AbortError"
  )
    return "timed out";
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  )
    return "TLS certificate not trusted — corporate proxy likely re-signs traffic; set NODE_EXTRA_CA_CERTS to the corp root CA bundle (never NODE_TLS_REJECT_UNAUTHORIZED=0)";
  const firstLine = String((err as any)?.message ?? err).split("\n")[0] ?? "unknown error";
  return scrubSecrets(firstLine);
}

async function connectivityChecks(env: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const source of Object.keys(SOURCES)) {
    const urlVar = `EIL_${source.toUpperCase()}_URL`;
    const url = env[urlVar];
    if (!url) continue; // not configured — nothing to reach
    try {
      await scopedFetch(url, { signal: AbortSignal.timeout(5_000) });
      out.push({
        name: `reach:${source}`,
        ok: true,
        detail: `${urlVar} reachable, TLS chain valid`,
      });
    } catch (err) {
      out.push({
        name: `reach:${source}`,
        ok: false,
        detail: `${urlVar} (${redactUrl(url)}): ${classifyFetchError(err)}`,
      });
    }
  }
  return out;
}

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    nodeVersionCheck(),
    proxyEnvCheck(env),
    await dbCheck(),
    keychainCheck(),
    ...connectorCredentialChecks(env),
    ...(await connectivityChecks(env)),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
