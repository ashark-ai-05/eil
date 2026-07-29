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
 */
export function isRetryable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  // Status codes as emitted by getJson/postJson: "GET /path -> 429"
  const status = /-> (\d{3})\b/.exec(msg)?.[1];
  if (status) {
    const n = Number(status);
    return n === 408 || n === 425 || n === 429 || (n >= 500 && n <= 599);
  }
  // Transport-level failures: timeouts, resets, DNS blips.
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|aborted/i.test(
    msg,
  );
}

export function backoffMs(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseMs ?? DEFAULTS.baseMs;
  const cap = opts.capMs ?? DEFAULTS.capMs;
  const rand = opts.random ?? Math.random;
  return Math.floor(rand() * Math.min(cap, base * 2 ** attempt));
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying retryable failures with full jitter. */
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
      const delay = backoffMs(i, opts);
      opts.onRetry?.(i + 1, delay, err as Error);
      await sleep(delay);
    }
  }
  throw last;
}
