/**
 * `eil doctor` — one preflight command answering "why won't this reach my
 * org's systems" before a corp-network first run wastes an hour on an
 * opaque timeout. Every check is loud and specific rather than a silent
 * pass/fail: docs/setup.md's corporate-network section (proxy, corp CA,
 * old-DC Basic-auth fallback) is exactly what a user has to remember today;
 * this is that section made executable.
 */

import { type DcClient, type Fetcher, makeClient } from "./connectors/auth.js";
import { doctorProbe as bitbucketDoctorProbe } from "./connectors/bitbucket.js";
import { doctorProbe as confluenceDoctorProbe } from "./connectors/confluence.js";
import { doctorProbe as elkDoctorProbe } from "./connectors/elk.js";
import { scopedFetch } from "./connectors/httpclient.js";
import { HttpRequestError } from "./connectors/httperror.js";
import { doctorProbe as jiraDoctorProbe } from "./connectors/jira.js";
import { SOURCES, getSecret, keychainBackend, resolvedSource } from "./connectors/keychain.js";
import { redactUrl, scrubSecrets } from "./connectors/redact.js";
import { connect, dsn, pendingMigrations, safeDsn } from "./db.js";

// Re-exported for backward compatibility — these lived inline in this file
// before being extracted to connectors/redact.ts so the HTTP client's own
// structured errors could redact through the same code.
export { redactUrl, scrubSecrets };

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Present only when a check was skipped rather than attempted — e.g. an
   *  authenticated probe that never made a network call because no
   *  credentials were found. Additive: absent on every check that predates
   *  this field, so existing consumers of the JSON report are unaffected. */
  blocked?: { reason: string };
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

/**
 * Minimal, read-only authenticated request per connector — proves the token
 * actually works, not just that it exists (see `connectorCredentialChecks`)
 * or that the host is reachable (see `connectivityChecks`). Each probe
 * takes the doctor-isolated `env` too, for the rare probe (ELK) that needs
 * additional configured scope (the index to search) beyond the client
 * itself — reading that from ambient `process.env` instead would reopen
 * exactly the isolation gap fixed below for credentials.
 *
 * Each is chosen to be identity- or scope-bound, not instance-wide
 * metadata: an endpoint a misconfigured or anonymous-access instance could
 * satisfy without a valid token would let this check report success for a
 * token that doesn't actually work.
 */
const AUTH_PROBES: Record<string, (client: DcClient, env: NodeJS.ProcessEnv) => Promise<void>> = {
  confluence: confluenceDoctorProbe,
  jira: jiraDoctorProbe,
  bitbucket: bitbucketDoctorProbe,
  elk: elkDoctorProbe,
};

/**
 * Classifies a failed authenticated probe. Distinct from `classifyFetchError`
 * (bare reachability): a `HttpRequestError` here means the connection and
 * TLS handshake succeeded and a real API response came back, so a 401/403
 * is reported as a credential problem specifically, not folded into the
 * generic transport-failure bucket.
 */
function classifyAuthError(err: unknown): string {
  if (err instanceof HttpRequestError) {
    const { status } = err.info;
    if (status === 401 || status === 403) {
      return `authentication rejected (${status}) — the token was reached but not accepted; it may be expired, revoked, or lack the required permission`;
    }
    return `request failed (${status ?? err.info.code})`;
  }
  return classifyFetchError(err);
}

/**
 * Every check here uses `makeClient()` — the same production client
 * construction connectors use for a real sync — not a parallel simplified
 * probe, per the "consuming the same production configuration paths"
 * requirement. This DOES query the OS keychain when no env token is set,
 * unlike `connectorCredentialChecks` above: an authenticated readiness
 * check that refuses to look at the one place a keychain-only setup keeps
 * its token would just be a worse reachability check.
 * `connectorCredentialChecks` stays side-effect-free by design; this is
 * the deliberately more thorough companion.
 *
 * `env` and `keychain` are both passed to `makeClient()` as an explicit
 * `CredentialSource` — never left to `makeClient`'s own real-`process.env`/
 * real-keychain default. A caller (a test) that supplies an `env` missing a
 * token must see exactly that: `makeClient` must not silently recover the
 * token from the REAL ambient environment or the REAL keychain underneath
 * an injected `env` — that would defeat the entire point of injecting one.
 * The production call (`runDoctor()` with no arguments) passes real
 * `process.env` and the real `getSecret`, so production behavior — do
 * consult the keychain — is unchanged.
 *
 * A configured URL with no credentials anywhere (in the given `env` or via
 * the given `keychain`) is reported as `blocked`, not as an authentication
 * failure — no network call is made, since there is nothing to
 * authenticate with yet.
 */
async function authReadinessChecks(
  env: NodeJS.ProcessEnv,
  keychain: (account: string) => string | null,
  fetcher?: Fetcher,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const source of Object.keys(SOURCES)) {
    const urlVar = `EIL_${source.toUpperCase()}_URL`;
    const url = env[urlVar];
    if (!url) continue; // not configured — nothing to authenticate
    const probe = AUTH_PROBES[source];
    if (!probe) continue; // no probe defined for this source yet

    const tokenVar = SOURCES[source]!;
    let client: DcClient;
    try {
      client = makeClient(source.toUpperCase(), url, undefined, fetcher, { env, keychain });
    } catch {
      out.push({
        name: `auth:${source}`,
        ok: false,
        blocked: { reason: "missing_credentials" },
        detail: `no credentials found in environment or keychain for ${urlVar} — run \`eil auth login ${source}\` or set ${tokenVar}`,
      });
      continue;
    }

    try {
      await probe(client, env);
      out.push({ name: `auth:${source}`, ok: true, detail: "authenticated request succeeded" });
    } catch (err) {
      out.push({ name: `auth:${source}`, ok: false, detail: classifyAuthError(err) });
    }
  }
  return out;
}

/**
 * `fetcher` and `keychain` are injectable seams for `authReadinessChecks`
 * alone (defaults reproduce real production behavior — `scopedFetch` and
 * the real OS keychain) — tests use them to prove doctor's authenticated
 * probes without a live Confluence/Jira/Bitbucket/ELK instance and without
 * a real credential anywhere in reach, the same injected-fetcher pattern
 * every connector test in this repo already uses.
 */
/**
 * Can this host sandbox a hostile parser?
 *
 * Mapped onto `DoctorCheck`'s single boolean with the three states preserved in
 * `blocked.reason`, because they warrant different responses:
 *
 *  - `platform_unsupported` and `isolation_unavailable` are **not** failures.
 *    Sandboxed extraction is opt-in, so a macOS laptop or a Linux host that has
 *    never enabled delegation should not fail `eil doctor` over a feature it is
 *    not using. The reason and the fix are still reported.
 *  - `isolation_broken` IS a failure. The host looks capable and is not — a
 *    memory limit that silently did not apply, or a channel that returns
 *    nothing. That is the only one an operator must act on, and the only one
 *    that would otherwise be mistaken for a platform limitation.
 */
export async function isolationCheck(): Promise<DoctorCheck> {
  const { probeIsolation } = await import("./isolation/index.js");
  const result = await probeIsolation();
  if (result.ok)
    return { name: "isolation", ok: true, detail: `${result.backend}: ${result.detail}` };
  const detail = result.fix ? `${result.detail} — ${result.fix}` : result.detail;
  return {
    name: "isolation",
    ok: result.reason !== "isolation_broken",
    detail,
    blocked: { reason: result.reason },
  };
}

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: Fetcher,
  keychain: (account: string) => string | null = getSecret,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    nodeVersionCheck(),
    proxyEnvCheck(env),
    await dbCheck(),
    keychainCheck(),
    ...connectorCredentialChecks(env),
    ...(await connectivityChecks(env)),
    ...(await authReadinessChecks(env, keychain, fetcher)),
    await isolationCheck(),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
