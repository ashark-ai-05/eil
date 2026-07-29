/**
 * Shared HTTP client factory for Atlassian DC connectors.
 * Default: Personal Access Token as a Bearer header (Jira 8.14+, Confluence
 * 7.9+, Bitbucket 5.5+, Bamboo 8.0+). EIL_<PREFIX>_USER switches to Basic
 * auth for instances predating PAT support. Local-mode rule: these are YOUR
 * credentials — a PAT inherits your permissions.
 */

import { getSecret } from "./keychain.js";
import { withRetry } from "./retry.js";

export type Fetcher = typeof fetch;

export interface DcClient {
  baseUrl: string;
  headers: Record<string, string>;
  fetcher: Fetcher;
}

export function makeClient(
  prefix: string,
  baseUrl?: string,
  token?: string,
  fetcher: Fetcher = fetch,
): DcClient {
  const url = (baseUrl ?? required(`EIL_${prefix}_URL`)).replace(/\/+$/, "");
  const tok = token ?? getSecret(`EIL_${prefix}_TOKEN`) ?? process.env[`EIL_${prefix}_TOKEN`];
  if (!tok) {
    throw new Error(
      `no ${prefix} token — run \`eil auth login ${prefix.toLowerCase()}\` or set EIL_${prefix}_TOKEN`,
    );
  }
  const user = process.env[`EIL_${prefix}_USER`];
  const headers = user
    ? { Authorization: `Basic ${Buffer.from(`${user}:${tok}`).toString("base64")}` }
    : { Authorization: `Bearer ${tok}` };
  return { baseUrl: url, headers, fetcher };
}

export function required(name: string): string {
  const value = process.env[name];
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
  // only delays the operator seeing a credential problem.
  return withRetry(async () => {
    const res = await client.fetcher(url, {
      headers: client.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  }, RETRY_OPTS);
}

export async function postJson(client: DcClient, path: string, body: unknown): Promise<any> {
  const res = await withRetry(async () => {
    const r = await client.fetcher(client.baseUrl + path, {
      method: "POST",
      headers: { ...client.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`POST ${path} -> ${r.status}`);
    return r;
  }, RETRY_OPTS);
  return res.json();
}
