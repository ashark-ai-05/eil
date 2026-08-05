/**
 * Scoped — never global — proxy-aware fetch for DC connectors.
 *
 * Node can be made proxy-aware process-wide via NODE_USE_ENV_PROXY=1, but
 * that mutates every fetch call in the host process, including a host
 * application's own unrelated calls when EIL is mounted as a library
 * (`import { callTool } from "eil/tools"` in someone else's MCP server).
 * This attaches the dispatcher only to the requests EIL itself makes, via
 * fetch's `dispatcher` option, so CLI and library usage behave identically
 * and EIL never reaches outside the requests it constructs.
 *
 * EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY (and lowercase
 * variants) itself and falls back to a plain direct dispatcher per-origin
 * when none apply, so it's safe to attach unconditionally rather than
 * branching on whether a proxy is configured.
 */

import { EnvHttpProxyAgent } from "undici";
import type { Fetcher } from "./auth.js";

let sharedAgent: EnvHttpProxyAgent | null = null;

/**
 * Built once per process and reused. EnvHttpProxyAgent reads proxy env vars
 * at construction time, so a fresh instance per request would be wasteful
 * (a new proxy connection per call) without adding correctness — the env
 * vars that matter are read once, at startup, same as HTTP_PROXY itself.
 */
function agent(): EnvHttpProxyAgent {
  sharedAgent ??= new EnvHttpProxyAgent();
  return sharedAgent;
}

/**
 * `dispatcher` is a Node-specific extension to fetch's init options that the
 * DOM-derived RequestInit type in lib.dom.d.ts doesn't declare, even though
 * Node's runtime fetch (built on undici) honors it.
 */
interface NodeFetchInit extends RequestInit {
  dispatcher?: EnvHttpProxyAgent;
}

/**
 * Scoped fetch: routes through the configured proxy, or direct if none is
 * set, without touching global fetch behavior. Pass as the `fetcher` to
 * `makeClient`; the existing injectable-fetcher seam means connector tests
 * and library consumers that construct their own client are unaffected.
 */
export const scopedFetch: Fetcher = ((input, init) => {
  const withDispatcher: NodeFetchInit = { ...init, dispatcher: agent() };
  // NodeFetchInit extends RequestInit, so this widens rather than lies —
  // fetch's own declared parameter type is the narrower DOM RequestInit,
  // which doesn't know about the Node-specific field it accepts at runtime.
  return fetch(input, withDispatcher as RequestInit);
}) as Fetcher;

/**
 * Close the shared dispatcher's sockets. Open keep-alive connections can
 * hold the event loop open, so short-lived processes (CLI commands, test
 * teardown) should call this before exiting.
 */
export async function closeScopedFetch(): Promise<void> {
  if (sharedAgent) {
    await sharedAgent.close();
    sharedAgent = null;
  }
}
