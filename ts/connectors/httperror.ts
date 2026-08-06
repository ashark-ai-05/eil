/**
 * Structured error for a completed-but-unsuccessful HTTP response, thrown by
 * `getJson`/`postJson`/`getRaw` instead of a bare `Error` string. Two things
 * this exists for:
 *
 * - `ts/connectors/retry.ts` can classify retryability and read a
 *   `Retry-After` hint off `.info` directly, instead of regex-parsing an
 *   error message whose exact format (`GET /path -> 429`) was an implicit,
 *   fragile contract between the two modules.
 * - The error can never carry a secret, because it is constructed FROM
 *   already-redacted parts (`redactUrlObject`) and never stores the
 *   response body, headers, Authorization header, or the `DcClient` itself.
 *   Redaction happens here, at construction, not at some later logging
 *   call site that could forget to scrub — `.message`, `.info`, and
 *   `JSON.stringify(err)`/`Object.keys(err)` are all safe to log verbatim.
 */

import { redactUrlObject } from "./redact.js";

export interface HttpErrorInfo {
  method: string;
  /** Scheme + host only — never userinfo, path, or query. */
  origin: string;
  /** Path + redacted query string — never userinfo. */
  path: string;
  /** Present only for a completed response; absent for a transport-level failure. */
  status?: number;
  /** Parsed and validated (non-negative, not already past) Retry-After hint
   *  in ms — present only when the server sent one. NOT cap-bounded here;
   *  `ts/connectors/retry.ts`'s `backoffMs` applies the configured `capMs`
   *  when it consumes this value, so the raw hint the server sent is what
   *  this field carries. */
  retryAfterMs?: number;
  /** Stable, machine-readable — never derived from response body text. */
  code: "http_status";
}

export class HttpRequestError extends Error {
  readonly info: HttpErrorInfo;

  constructor(info: HttpErrorInfo) {
    super(`${info.method} ${info.origin}${info.path} -> ${info.status ?? info.code}`);
    this.name = "HttpRequestError";
    this.info = info;
  }

  /** `JSON.stringify(err)`/`console.log(err)` surface only the already-redacted info. */
  toJSON(): HttpErrorInfo {
    return this.info;
  }
}

/**
 * Builds a redacted `HttpRequestError` from a request URL and the response
 * that failed it. `retryAfterMs` is resolved by the caller (see
 * `ts/connectors/retry.ts`'s `parseRetryAfter`) since parsing needs an
 * injectable clock for deterministic HTTP-date tests, which this
 * construction helper doesn't need to know about.
 */
export function httpError(
  method: string,
  url: URL,
  status: number,
  retryAfterMs?: number | null,
): HttpRequestError {
  const redacted = redactUrlObject(url);
  return new HttpRequestError({
    method,
    origin: redacted.origin,
    path: `${redacted.pathname}${redacted.search}`,
    status,
    ...(retryAfterMs !== undefined && retryAfterMs !== null ? { retryAfterMs } : {}),
    code: "http_status",
  });
}
