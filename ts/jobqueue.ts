/**
 * Durable Postgres-backed job queue — the primitive only (F5a). Nothing in
 * this file wires ingestion or connector schedules onto it; that is a
 * separate, reviewed slice (F5b) built on top of this once it has proven
 * itself under real concurrency.
 *
 * Extends EIL's own "one Postgres, no extension" principle to scheduling
 * rather than adopting an external queue (Rabbit/Redis/SQS) by default —
 * the same reasoning that already justified PGlite over requiring a
 * Postgres binary for the local tier.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes concurrent claims safe: two
 * workers racing the same claim() call never see the same row, because a
 * locked-but-not-yet-committed row is invisible to the other's scan rather
 * than blocking it. This can only be proven under real Postgres — PGlite is
 * one in-process connection and cannot represent two concurrent workers.
 *
 * Ownership is two independent checks, not one: `lease_owner` names who
 * currently holds the lease, and `fence_token` proves the caller's view of
 * that lease is not stale. A fence token alone is fencing, not ownership —
 * requiring both, plus an unexpired lease, at the moment of every write is
 * what closes the gap between "my lease technically expired a moment ago"
 * and "someone else has already reclaimed this job."
 */

import type { z } from "zod";
import { backoffMs } from "./connectors/retry.js";
import type { Db } from "./db.js";
import { redact, scanSecrets } from "./ingest/secrets.js";

export const JOB_STATUSES = ["pending", "claimed", "completed", "dead_letter"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Field names match the `jobs` table columns directly (snake_case), the
 * same convention `ts/store.ts` already uses for row access — no ORM-style
 * camelCase mapping layer.
 */
export interface Job {
  id: string;
  tenant: string;
  job_type: string;
  payload: unknown;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fence_token: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

const MAX_ERROR_LENGTH = 2_000;
const MAX_STRING_FIELD_LENGTH = 500;
const MAX_BATCH_SIZE = 1_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000; // 24h
const MAX_ATTEMPTS_BOUND = 100;

/**
 * Scrubs credentials out of job-processing error text before it can be
 * persisted, using the same secret-detection engine EIL already trusts for
 * ingested document bodies (`ts/ingest/secrets.ts`) rather than a narrower
 * bespoke regex — a connector error can legitimately embed a URL with a
 * token or an AWS key from an upstream failure message. Redact against the
 * full text first, then bound the length; bounding first could bisect a
 * secret across the truncation point and leave an unredacted fragment.
 */
export function scrubJobError(text: string): string {
  const scrubbed = redact(text, scanSecrets(text));
  return scrubbed.slice(0, MAX_ERROR_LENGTH);
}

const JOB_SCHEMAS = new Map<string, z.ZodType>();

/**
 * Registers the payload contract for a job type. F5a ships with no real
 * job types registered — F5b registers real ones when it wires ingestion —
 * so this exists to make payload validation structurally required rather
 * than optional, testable with a fixture type today.
 */
export function registerJobType(jobType: string, schema: z.ZodType): void {
  JOB_SCHEMAS.set(jobType, schema);
}

/** Test-only: clears registrations so test files don't leak types into each other. */
export function _clearJobTypesForTests(): void {
  JOB_SCHEMAS.clear();
}

export class UnknownJobTypeError extends Error {
  constructor(jobType: string) {
    super(`unknown job type: ${jobType} — call registerJobType() before enqueueing it`);
    this.name = "UnknownJobTypeError";
  }
}

export class InvalidJobPayloadError extends Error {
  constructor(jobType: string, detail: string) {
    super(`invalid payload for job type ${jobType}: ${detail}`);
    this.name = "InvalidJobPayloadError";
  }
}

export class SecretInPayloadError extends Error {
  constructor(jobType: string, rule: string) {
    super(
      `payload for job type ${jobType} looks like it contains a credential (${rule}) — job payloads must reference secrets by name, not carry them`,
    );
    this.name = "SecretInPayloadError";
  }
}

/**
 * A duplicate enqueue is a no-op only when the intent matches — the same
 * job type and the same payload. Reusing a key with a different type or
 * payload is a bug in the caller (or a genuine key collision), and
 * silently returning unrelated existing work would hide it.
 */
export class IdempotencyConflictError extends Error {
  constructor(tenant: string, idempotencyKey: string) {
    super(
      `idempotency key "${idempotencyKey}" for tenant "${tenant}" is already used by a job with a different type or payload`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidJobQueueArgumentError extends Error {
  constructor(field: string, detail: string) {
    super(`invalid ${field}: ${detail}`);
    this.name = "InvalidJobQueueArgumentError";
  }
}

/**
 * Bounds public-facing scalar inputs before they reach SQL — a batch size,
 * lease duration, or attempt bound is exactly the kind of caller-supplied
 * number that ends up embedded in an interval or LIMIT clause, and NaN,
 * negative, zero, or absurdly large values should be rejected here rather
 * than delegated to whatever Postgres happens to do with them.
 */
function requireNonEmptyString(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidJobQueueArgumentError(field, "must be a non-empty, non-whitespace string");
  }
  if (value.length > MAX_STRING_FIELD_LENGTH) {
    throw new InvalidJobQueueArgumentError(
      field,
      `must be at most ${MAX_STRING_FIELD_LENGTH} characters`,
    );
  }
}

function requirePositiveBoundedInt(field: string, value: number, max: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new InvalidJobQueueArgumentError(field, "must be a positive finite integer");
  }
  if (value > max) {
    throw new InvalidJobQueueArgumentError(field, `must be at most ${max}`);
  }
}

function requireValidDate(field: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidJobQueueArgumentError(field, "must be a valid Date");
  }
}

// jobs.id and jobs.fence_token are Postgres bigint, and both are always
// >= 1 in practice (bigserial starts at 1; fence_token is only ever handed
// to a caller after claim()'s own +1). A loosely-validated "non-empty
// string" let values like "abc" reach SQL and fail as an invalid bigint
// literal instead of a typed argument error. No leading zeros/signs/
// whitespace, and bounded to what actually fits in a signed 64-bit int.
const INT64_MAX = 9223372036854775807n;

function requireBigintIdString(field: string, value: string): void {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new InvalidJobQueueArgumentError(
      field,
      "must be a canonical positive integer string (no leading zeros, sign, or whitespace)",
    );
  }
  if (BigInt(value) > INT64_MAX) {
    throw new InvalidJobQueueArgumentError(field, "must fit in a signed 64-bit integer");
  }
}

/**
 * Converts a validated payload into the exact JSON value/text pair that
 * will be stored and compared. `JSON.stringify` can return `undefined`
 * (top-level undefined/function/symbol) or throw (circular references,
 * BigInt) — a zod schema like `z.any()` does not rule those out on its
 * own. Re-parsing the stringified text (rather than trusting the original
 * parsed value) is what makes the later idempotency comparison agree with
 * what jsonb actually stores: a Date, for instance, serializes to an ISO
 * string, and comparing the original Date object against the DB's
 * deserialized string would wrongly report a conflict for a true repeat.
 */
function toCanonicalJson(jobType: string, value: unknown): { json: unknown; text: string } {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new InvalidJobPayloadError(
      jobType,
      `payload must be JSON-serializable: ${(err as Error).message}`,
    );
  }
  if (text === undefined) {
    throw new InvalidJobPayloadError(
      jobType,
      "payload must serialize to a JSON value, not undefined/a function/a symbol",
    );
  }
  return { json: JSON.parse(text), text };
}

/**
 * Deep-equal for JSON-shaped values only (the payload contract) — not a
 * general-purpose utility. Object key order is not assumed significant.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) => jsonDeepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  runAfter?: Date;
}

/**
 * Enqueues a job, or returns the existing one if `(tenant, idempotencyKey)`
 * already has a row with the same job type and payload. A key reused with a
 * different type or payload throws IdempotencyConflictError rather than
 * silently returning unrelated work.
 */
export async function enqueue(
  client: Db,
  tenant: string,
  jobType: string,
  payload: unknown,
  idempotencyKey: string,
  opts: EnqueueOptions = {},
): Promise<Job> {
  requireNonEmptyString("tenant", tenant);
  requireNonEmptyString("jobType", jobType);
  requireNonEmptyString("idempotencyKey", idempotencyKey);
  const maxAttempts = opts.maxAttempts ?? 5;
  requirePositiveBoundedInt("maxAttempts", maxAttempts, MAX_ATTEMPTS_BOUND);
  const runAfter = opts.runAfter ?? new Date();
  requireValidDate("runAfter", runAfter);

  const schema = JOB_SCHEMAS.get(jobType);
  if (!schema) throw new UnknownJobTypeError(jobType);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new InvalidJobPayloadError(jobType, parsed.error.message);
  const canonical = toCanonicalJson(jobType, parsed.data);

  const findings = scanSecrets(canonical.text);
  if (findings.length > 0) throw new SecretInPayloadError(jobType, findings[0]!.rule);

  const inserted = await client.query(
    `INSERT INTO jobs (tenant, job_type, payload, idempotency_key, max_attempts, run_after)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant, idempotency_key) DO NOTHING
     RETURNING *`,
    [tenant, jobType, canonical.text, idempotencyKey, maxAttempts, runAfter],
  );
  if (inserted.rows.length > 0) return inserted.rows[0];

  // ON CONFLICT DO NOTHING inserted zero rows: the row already existed.
  // A true duplicate (same type + payload + max_attempts) is a no-op;
  // anything else is a key collision between two different intents and
  // must not be conflated. Comparing against `canonical.json` (not
  // `parsed.data`) matters here: both sides of the comparison have now
  // been through the same JSON round-trip that jsonb storage itself
  // performs, so a payload containing e.g. a Date compares equal to its
  // own stored form instead of failing a typeof mismatch against
  // unrelated work. `max_attempts` is part of identity too — reusing a
  // key with the same payload but a different retry budget would
  // otherwise silently hand back a job governed by the old policy.
  // `run_after` is deliberately NOT part of identity: it is a scheduling
  // hint, not the work's identity, and a duplicate enqueue never
  // reschedules existing work — two callers racing to enqueue "the same
  // job, right now" will naturally compute run_after a few milliseconds
  // apart even when they agree on everything else that matters.
  const existing = await client.query(
    "SELECT * FROM jobs WHERE tenant = $1 AND idempotency_key = $2",
    [tenant, idempotencyKey],
  );
  const row: Job = existing.rows[0];
  const sameIntent =
    row.job_type === jobType &&
    row.max_attempts === maxAttempts &&
    jsonDeepEqual(row.payload, canonical.json);
  if (!sameIntent) throw new IdempotencyConflictError(tenant, idempotencyKey);
  return row;
}

export interface ClaimOptions {
  leaseMs?: number;
  batchSize?: number;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;

/**
 * Atomically claims up to `batchSize` jobs: pending jobs whose `run_after`
 * has arrived, plus claimed jobs whose lease has expired (a worker that
 * died mid-processing without heartbeating). Not tenant-scoped — one
 * worker pool serves every tenant, the same shape as a real shared
 * deployment's worker fleet; each returned job carries its own tenant.
 *
 * Two separate statements, deliberately not folded into one:
 *
 * 1. Sweep: dead-letter every expired-lease row that has already used its
 *    last granted attempt (`attempts >= max_attempts`), with no `LIMIT`
 *    and no fence_token bump — no new claim is being granted, so nothing
 *    here should compete for this call's batch quota. Once dead-lettered
 *    a row leaves `status = 'claimed'`, so it can never be re-swept.
 * 2. Grant: `LIMIT $3` now applies only to genuinely grantable candidates
 *    (`attempts < max_attempts`), each unconditionally incremented,
 *    leased, and fenced.
 *
 * Folding both into one statement (as an earlier version did, deciding
 * grant-vs-dead-letter per row *after* the `LIMIT`) let a run of exhausted
 * expired leases sorted ahead of ready pending work consume the entire
 * requested batch on dead-lettering alone, returning an empty claim even
 * though real work was sitting immediately behind them — a worker would
 * sleep despite available work, and the same exhausted rows would keep
 * winning that `LIMIT` on every subsequent poll. Sweeping first, with no
 * `LIMIT`, means the grant step's `LIMIT` never sees an exhausted row at
 * all.
 *
 * The final SELECT imposes the same `(run_after, id)` order the candidate
 * scan uses — `UPDATE ... RETURNING` alone carries no ordering guarantee,
 * and callers (and tests) depend on the returned batch being ordered.
 */
export async function claim(client: Db, workerId: string, opts: ClaimOptions = {}): Promise<Job[]> {
  requireNonEmptyString("workerId", workerId);
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  requirePositiveBoundedInt("leaseMs", leaseMs, MAX_LEASE_MS);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  requirePositiveBoundedInt("batchSize", batchSize, MAX_BATCH_SIZE);

  await client.query(
    `UPDATE jobs SET
       status = 'dead_letter',
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error = 'exceeded max_attempts: repeatedly reclaimed after lease expiry without a reported failure (worker likely crashed)',
       updated_at = now()
     WHERE status = 'claimed' AND lease_expires_at < now() AND attempts >= max_attempts`,
  );

  const res = await client.query(
    `WITH candidates AS (
       SELECT id FROM jobs
       WHERE (status = 'pending' AND run_after <= now())
          OR (status = 'claimed' AND lease_expires_at < now() AND attempts < max_attempts)
       ORDER BY run_after ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     ),
     updated AS (
       UPDATE jobs j
       SET attempts = j.attempts + 1,
           status = 'claimed',
           lease_owner = $1,
           lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           fence_token = j.fence_token + 1,
           claimed_at = now(),
           updated_at = now()
       FROM candidates
       WHERE j.id = candidates.id
       RETURNING j.*
     )
     SELECT * FROM updated ORDER BY run_after ASC, id ASC`,
    [workerId, String(leaseMs), batchSize],
  );
  return res.rows;
}

/**
 * Extends a held lease. Requires the caller to still be the current owner
 * by lease_owner AND fence_token, with an unexpired lease and status still
 * 'claimed' — a worker whose lease already lapsed is rejected even if
 * nobody has reclaimed the row yet, because the system already considers
 * that lease available and a heartbeat must not silently revive it.
 */
export async function heartbeat(
  client: Db,
  jobId: string,
  workerId: string,
  fenceToken: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  requireBigintIdString("jobId", jobId);
  requireNonEmptyString("workerId", workerId);
  requireBigintIdString("fenceToken", fenceToken);
  requirePositiveBoundedInt("leaseMs", leaseMs, MAX_LEASE_MS);
  const res = await client.query(
    `UPDATE jobs SET lease_expires_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND fence_token = $3
       AND status = 'claimed' AND lease_expires_at > now()
     RETURNING id`,
    [jobId, workerId, fenceToken, String(leaseMs)],
  );
  return res.rows.length > 0;
}

/**
 * Marks a claimed job completed. Same ownership + unexpired-lease check as
 * heartbeat. Clears lease fields — a completed job must not still look
 * claimed to anything inspecting lease_owner/lease_expires_at.
 */
export async function complete(
  client: Db,
  jobId: string,
  workerId: string,
  fenceToken: string,
): Promise<boolean> {
  requireBigintIdString("jobId", jobId);
  requireNonEmptyString("workerId", workerId);
  requireBigintIdString("fenceToken", fenceToken);
  const res = await client.query(
    `UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now(),
        lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2 AND fence_token = $3
       AND status = 'claimed' AND lease_expires_at > now()
     RETURNING id`,
    [jobId, workerId, fenceToken],
  );
  return res.rows.length > 0;
}

export interface FailResult {
  status: "pending" | "dead_letter";
}

/**
 * Records a processing failure. Ownership-checked the same way as
 * heartbeat/complete (owner + fence + unexpired lease + status). The
 * retry-vs-dead_letter DECISION is made entirely inside a single fenced
 * atomic UPDATE, from the row's own `attempts`/`max_attempts` at the
 * moment it writes — never from values the caller happens to be holding.
 *
 * This deliberately issues no `BEGIN`/`COMMIT`/`ROLLBACK` of its own: `Db`
 * is caller-owned, and a worker may legitimately call `fail()` from inside
 * its own already-open transaction. An earlier version wrapped the two
 * statements below in its own transaction, which — invoked inside a
 * caller's transaction — would have silently committed or aborted more
 * than fail() was ever entitled to touch. The one remaining wrinkle is the
 * backoff delay: `backoffMs()` needs a JS-injectable `random` for
 * deterministic tests, so it can't be computed inside the atomic UPDATE.
 * The preliminary SELECT below is a non-authoritative peek used only to
 * size that delay — if it races with a concurrent change, the delay
 * magnitude may be slightly off, but the actual pending-vs-dead_letter
 * transition is decided fresh, from scratch, by the atomic UPDATE's own
 * WHERE/CASE, so that decision is never affected by the peek being stale.
 */
export async function fail(
  client: Db,
  jobId: string,
  workerId: string,
  fenceToken: string,
  error: string,
  opts: { random?: () => number } = {},
): Promise<FailResult | null> {
  requireBigintIdString("jobId", jobId);
  requireNonEmptyString("workerId", workerId);
  requireBigintIdString("fenceToken", fenceToken);
  const scrubbed = scrubJobError(error);

  const peek = await client.query(
    `SELECT attempts FROM jobs
     WHERE id = $1 AND lease_owner = $2 AND fence_token = $3
       AND status = 'claimed' AND lease_expires_at > now()`,
    [jobId, workerId, fenceToken],
  );
  if (peek.rows.length === 0) return null;
  const delayMs = backoffMs(peek.rows[0].attempts, opts);

  const res = await client.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
       last_error = $5,
       run_after = CASE WHEN attempts >= max_attempts THEN run_after
                         ELSE now() + ($4 || ' milliseconds')::interval END,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND fence_token = $3
       AND status = 'claimed' AND lease_expires_at > now()
     RETURNING (CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END) AS next_status`,
    [jobId, workerId, fenceToken, String(delayMs), scrubbed],
  );
  if (res.rows.length === 0) return null;
  return { status: res.rows[0].next_status };
}

/**
 * Explicit operator action: moves a dead-lettered job back to pending with
 * a clean attempt count. Never automatic — a job only reaches dead_letter
 * after exhausting its attempts, and replaying it is a deliberate decision,
 * not something the queue does on its own.
 */
export async function replay(client: Db, jobId: string): Promise<boolean> {
  requireBigintIdString("jobId", jobId);
  const res = await client.query(
    `UPDATE jobs SET status = 'pending', attempts = 0, run_after = now(),
        last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'dead_letter'
     RETURNING id`,
    [jobId],
  );
  return res.rows.length > 0;
}
