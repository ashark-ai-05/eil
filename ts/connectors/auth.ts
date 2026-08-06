/**
 * Shared HTTP client factory for Atlassian DC connectors.
 * Default: Personal Access Token as a Bearer header (Jira 8.14+, Confluence
 * 7.9+, Bitbucket 5.5+, Bamboo 8.0+). EIL_<PREFIX>_USER switches to Basic
 * auth for instances predating PAT support. Local-mode rule: these are YOUR
 * credentials — a PAT inherits your permissions.
 */

import { scopedFetch } from "./httpclient.js";
import { RedirectRefused, ResponseTooLarge, httpError } from "./httperror.js";
import { getSecret } from "./keychain.js";
import { parseRetryAfter, withRetry } from "./retry.js";

export type Fetcher = typeof fetch;

export interface DcClient {
  baseUrl: string;
  headers: Record<string, string>;
  fetcher: Fetcher;
}

/**
 * Where `makeClient` reads env vars and the OS-keychain lookup from. The
 * production default (`DEFAULT_CREDENTIAL_SOURCE`) is real `process.env`
 * plus the real keychain — every existing connector constructor gets this
 * automatically and is unaffected. A caller that needs isolation (doctor's
 * authenticated-readiness checks, which accept an injected test `env`)
 * passes its own `CredentialSource` explicitly instead: `makeClient` must
 * never fall through to ambient `process.env` or the real keychain once a
 * caller has opted into supplying its own source — the whole point of
 * injecting a test env is defeated if a stray real credential can still
 * leak in underneath it.
 */
export interface CredentialSource {
  env: NodeJS.ProcessEnv;
  /** Returns null for "not found" — never throws for a missing account. */
  keychain: (account: string) => string | null;
}

const DEFAULT_CREDENTIAL_SOURCE: CredentialSource = { env: process.env, keychain: getSecret };

export function makeClient(
  prefix: string,
  baseUrl?: string,
  token?: string,
  fetcher: Fetcher = scopedFetch,
  credentials: CredentialSource = DEFAULT_CREDENTIAL_SOURCE,
): DcClient {
  const url = (baseUrl ?? required(`EIL_${prefix}_URL`, credentials.env)).replace(/\/+$/, "");
  const tok =
    token ?? credentials.keychain(`EIL_${prefix}_TOKEN`) ?? credentials.env[`EIL_${prefix}_TOKEN`];
  if (!tok) {
    throw new Error(
      `no ${prefix} token — run \`eil auth login ${prefix.toLowerCase()}\` or set EIL_${prefix}_TOKEN`,
    );
  }
  const user = credentials.env[`EIL_${prefix}_USER`];
  const headers = user
    ? { Authorization: `Basic ${Buffer.from(`${user}:${tok}`).toString("base64")}` }
    : { Authorization: `Bearer ${tok}` };
  return { baseUrl: url, headers, fetcher };
}

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

const RETRY_OPTS = {
  onRetry: (attempt: number, delayMs: number, err: Error) =>
    console.error(`  retry ${attempt} in ${delayMs}ms: ${err.message}`),
};

/** A stalled upstream must never hang a tool call indefinitely. */
export const FETCH_TIMEOUT_MS = 30_000;

export async function getJson(
  client: DcClient,
  path: string,
  params?: Record<string, string | number>,
): Promise<any> {
  const url = new URL(client.baseUrl + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  // Retry here rather than at each connector: this is the one funnel every DC
  // read goes through, so a 429 anywhere becomes survivable in one place.
  // Non-retryable statuses (401, 404) still fail immediately — retrying them
  // only delays the operator seeing a credential problem. AbortSignal.timeout
  // is constructed fresh inside this closure, so a retried attempt always
  // gets its own live signal rather than reusing one a prior attempt aborted.
  return withRetry(async () => {
    const res = await client.fetcher(url, {
      headers: client.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok)
      throw httpError("GET", url, res.status, parseRetryAfter(res.headers.get("retry-after")));
    return res.json();
  }, RETRY_OPTS);
}

/**
 * `idempotency` is required, not defaulted, so a new POST call site must
 * consciously choose rather than silently inheriting blind-retry semantics
 * from whatever the last caller happened to pick. `"query"` is for
 * read-shaped POST endpoints (Confluence CQL, Jira JQL, Elasticsearch
 * `_search` — APIs that use POST only to carry a request body, not to
 * mutate anything) and is retried like `getJson`. `"none"` is for anything
 * that isn't provably a read — EIL performs no writes back to Jira/
 * Confluence today, but the day a write-shaped endpoint is added, this
 * forces that decision to be explicit instead of inherited.
 */
export async function postJson(
  client: DcClient,
  path: string,
  body: unknown,
  idempotency: "query" | "none",
): Promise<any> {
  const url = client.baseUrl + path;
  const attempt = async () => {
    const r = await client.fetcher(url, {
      method: "POST",
      headers: { ...client.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      throw httpError(
        "POST",
        new URL(url),
        r.status,
        parseRetryAfter(r.headers.get("retry-after")),
      );
    }
    return r;
  };
  const res = idempotency === "query" ? await withRetry(attempt, RETRY_OPTS) : await attempt();
  return res.json();
}

/**
 * Non-JSON GET (raw file content) through the same timeout+retry funnel as
 * `getJson`, instead of a connector reaching for `client.fetcher` directly
 * and silently losing both. `maxBytes`, when given, is enforced before any
 * body is accepted where possible (a `Content-Length` over the cap is
 * rejected without reading) and while streaming otherwise (Content-Length
 * can be absent or understated) — a retryable status is always detected
 * before any body byte is read, so a retry never happens mid-consumption:
 * each attempt starts a fresh, empty read, never resuming a partial one.
 */
export async function getRaw(client: DcClient, path: string, maxBytes?: number): Promise<string> {
  const url = new URL(client.baseUrl + path);
  return withRetry(async () => {
    const res = await client.fetcher(url, {
      headers: client.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok)
      throw httpError("GET", url, res.status, parseRetryAfter(res.headers.get("retry-after")));
    return readBoundedText(res, maxBytes);
  }, RETRY_OPTS);
}

/**
 * Read a response body as bytes, bounded three ways.
 *
 * Bytes rather than text is the point: `res.text()` decodes as UTF-8, which
 * silently mangles any binary payload before it can be hashed. A digest taken
 * over mangled bytes names content that never existed, so re-derivation — the
 * whole reason artifacts are retained — would be worthless.
 *
 * All three checks are needed and none subsumes the others. `Content-Length` is
 * a claim the server makes and may understate or omit; the streaming total
 * catches that but only as bytes arrive; and the final accepted length is the
 * only number that describes what would actually be stored.
 */
async function readBoundedBytes(res: Response, maxBytes?: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    // Cancelled BEFORE a byte is consumed: refusing after buffering would
    // defeat the ceiling it is enforcing.
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLarge(maxBytes, declared, "content-length");
  }
  if (!res.body) {
    // No stream to meter, but the accepted length still has to be checked: a
    // body-less response is not a size-less one, and returning it unchecked
    // would let the ceiling be bypassed by whichever runtime path produced it.
    const whole = Buffer.from(await res.arrayBuffer());
    if (maxBytes !== undefined && whole.length > maxBytes)
      throw new ResponseTooLarge(maxBytes, whole.length, "accepted");
    return whole;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLarge(maxBytes, total, "stream");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  // The accepted buffer, checked last. The two checks above are about what was
  // promised and what arrived; this is about what would be stored.
  if (maxBytes !== undefined && buf.length > maxBytes)
    throw new ResponseTooLarge(maxBytes, buf.length, "accepted");
  return buf;
}

async function readBoundedText(res: Response, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return res.text();
  return (await readBoundedBytes(res, maxBytes)).toString("utf-8");
}

/** How many same-origin hops a download may take before we stop following. */
export const MAX_REDIRECT_HOPS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch, following redirects ONLY while they stay on the origin we authenticated
 * to.
 *
 * The default `redirect: "follow"` is unsafe for an authenticated download: the
 * runtime re-sends the request to whatever `Location` names, and `client.headers`
 * carries the enterprise PAT. A page whose attachment link 302s to an external
 * host would therefore hand that token to the external host, and nothing in the
 * response would show it happened.
 *
 * So redirects are taken manually. Every hop is resolved and its origin compared
 * to the origin we started from BEFORE any second request is made — a
 * cross-origin hop is refused without ever being fetched, which is the property
 * that matters: not "we discarded the response" but "we never sent the header".
 */
async function fetchSameOrigin(client: DcClient, start: URL): Promise<Response> {
  const origin = new URL(client.baseUrl).origin;
  let url = start;
  for (let hop = 0; ; hop++) {
    const res = await client.fetcher(url, {
      headers: client.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "manual",
    });
    if (!REDIRECT_STATUS.has(res.status)) return res;

    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (location === null) throw new RedirectRefused(url.toString(), "(none)", "missing-location");

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new RedirectRefused(url.toString(), location, "cross-origin");
    }
    if (next.origin !== origin)
      throw new RedirectRefused(url.toString(), next.toString(), "cross-origin");
    // Bounded AFTER the origin check so a same-origin loop is reported as a
    // loop rather than as an escape attempt.
    if (hop >= MAX_REDIRECT_HOPS)
      throw new RedirectRefused(url.toString(), next.toString(), "hop-limit");
    url = next;
  }
}

/**
 * Fetch a binary body through the shared timeout/retry funnel.
 *
 * A fresh `AbortSignal` per attempt, constructed inside the retried closure, so
 * a retry never reuses an already-aborted signal. A size refusal is NOT
 * retryable — the file will be the same size next time — so it propagates as
 * `ResponseTooLarge` rather than being folded into the transport error the
 * retry policy inspects.
 */
export async function getBytes(client: DcClient, path: string, maxBytes?: number): Promise<Buffer> {
  const url = new URL(client.baseUrl + path);
  return withRetry(async () => {
    const res = await fetchSameOrigin(client, url);
    // Status is inspected before any body byte is read, so a retryable failure
    // never begins a stream it would have to abandon half-consumed.
    if (!res.ok)
      throw httpError("GET", url, res.status, parseRetryAfter(res.headers.get("retry-after")));
    return readBoundedBytes(res, maxBytes);
  }, RETRY_OPTS);
}
