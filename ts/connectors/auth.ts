/**
 * Shared HTTP client factory for Atlassian DC connectors.
 * Default: Personal Access Token as a Bearer header (Jira 8.14+, Confluence
 * 7.9+, Bitbucket 5.5+, Bamboo 8.0+). EIL_<PREFIX>_USER switches to Basic
 * auth for instances predating PAT support. Local-mode rule: these are YOUR
 * credentials — a PAT inherits your permissions.
 */

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
  const tok = token ?? required(`EIL_${prefix}_TOKEN`);
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

/** A stalled upstream must never hang a tool call indefinitely. */
export const FETCH_TIMEOUT_MS = 30_000;

export async function getJson(
  client: DcClient,
  path: string,
  params?: Record<string, string | number>,
): Promise<any> {
  const url = new URL(client.baseUrl + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const res = await client.fetcher(url, {
    headers: client.headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

export async function postJson(client: DcClient, path: string, body: unknown): Promise<any> {
  const res = await client.fetcher(client.baseUrl + path, {
    method: "POST",
    headers: { ...client.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}
