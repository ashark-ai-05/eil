/**
 * Retry with full jitter.
 *
 * Nothing in the ingest path retried anything, so a single 429 aborted a whole
 * sync — and because an error thrown from a connector's async generator escapes
 * `for await` before `setCursor` runs, that abort also discarded every page of
 * progress made before it. A source that reliably rate-limits at the same offset
 * therefore produced an unbreakable livelock: every run re-fetched the same
 * prefix, failed at the same place, and advanced nothing.
 *
 * Backoff is `sleep = random(0, min(cap, base * 2^attempt))` — "full jitter"
 * from Marc Brooker's AWS analysis, which measured it as both less client work
 * and less server load than un-jittered exponential backoff. The randomness is
 * the point: deterministic backoff synchronises concurrent clients into
 * retrying in lockstep, which is what turns a blip into an outage.
 *
 * Note this is the one place in EIL where non-determinism is correct. The
 * retrieval path is deterministic by contract; a backoff schedule is not part of
 * any result and must not be predictable.
 */

import { HttpRequestError } from "./httperror.js";

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  /** Injected in tests so a retry schedule costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to make the jitter reproducible. */
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: Error) => void;
}

const DEFAULTS = {
  attempts: 5,
  baseMs: 1_000,
  capMs: 60_000,
};

/**
 * Retryable = the upstream might succeed if asked again. A 401 or a 404 will
 * not, and retrying them wastes the budget that a real blip needs — worse, it
 * delays the operator seeing a credential problem behind a minute of silence.
 *
 * A completed response (`HttpRequestError`) is classified off its own typed
 * `.info.status` — no message parsing. Anything else (a raw exception from
 * `fetch` itself: DNS blips, resets, aborts) has no status to read, so those
 * are still classified by matching the runtime's own error message shape.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpRequestError) {
    const { status } = err.info;
    if (status === undefined) return false;
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }
  const msg = String((err as Error)?.message ?? err);
  // Transport-level failures: timeouts, resets, DNS blips.
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|aborted/i.test(
    msg,
  );
}

/**
 * `serverHintMs` (a validated `Retry-After` value) never SHORTENS the
 * client's own jittered backoff — only lengthens it. Honoring a tiny or
 * stale hint verbatim would let a misbehaving/compromised upstream defeat
 * the jitter that exists specifically to avoid synchronized retry storms.
 */
export function backoffMs(attempt: number, opts: RetryOptions = {}, serverHintMs?: number): number {
  const base = opts.baseMs ?? DEFAULTS.baseMs;
  const cap = opts.capMs ?? DEFAULTS.capMs;
  const rand = opts.random ?? Math.random;
  const jittered = Math.floor(rand() * Math.min(cap, base * 2 ** attempt));
  if (serverHintMs === undefined) return jittered;
  return Math.min(cap, Math.max(serverHintMs, jittered));
}

/**
 * Parses a `Retry-After` header value per RFC 9110 §10.2.3: either
 * delta-seconds (a non-negative integer) or an HTTP-date. Returns `null`
 * for anything invalid, negative, or a date that has already passed —
 * those carry no usable hint, so the caller falls back to normal jittered
 * backoff rather than treating "invalid" the same as "wait zero seconds."
 * `now` is an injected clock so HTTP-date parsing is deterministic in tests.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: () => number = Date.now,
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaMs = dateMs - now();
  return deltaMs > 0 ? deltaMs : null;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying retryable failures with full jitter (plus any server Retry-After hint). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const sleep = opts.sleep ?? wait;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const hint = err instanceof HttpRequestError ? err.info.retryAfterMs : undefined;
      const delay = backoffMs(i, opts, hint);
      opts.onRetry?.(i + 1, delay, err as Error);
      await sleep(delay);
    }
  }
  throw last;
}
