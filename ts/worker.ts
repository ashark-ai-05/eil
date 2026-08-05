/**
 * F5b: a bounded worker pool wiring the durable Postgres queue
 * (ts/jobqueue.ts) onto the EXISTING ingestion pipeline
 * (ts/ingest/pipeline.ts). This file adds no ingestion logic of its own —
 * only job-type registration, dispatch to the same functions `eil ingest
 * ...` already calls synchronously, and pool lifecycle. Today's synchronous
 * CLI path (and the local/PGlite tier it backs) is completely untouched;
 * queued execution is an explicit opt-in for a real-Postgres deployment
 * (see `eil worker run` / `eil schedule ...` in cli.ts), never the default.
 */

import { z } from "zod";
import { BitbucketApiSource, GitCloneSource, type RepoSource } from "./connectors/reposource.js";
import { type Scope, cursorKey } from "./connectors/scope.js";
import type { Db } from "./db.js";
import { detectSource, repoKey } from "./ingest/code.js";
import { walkVault } from "./ingest/obsidian.js";
import {
  type ConfluenceLike,
  type JiraLike,
  ingestConfluenceScope,
  ingestDocs,
  ingestJiraScope,
  ingestRepo,
  runReconcile,
} from "./ingest/pipeline.js";
import { RepoFilter } from "./ingest/repofilter.js";
import {
  type EnqueueOptions,
  type Job,
  claim,
  complete,
  enqueue,
  fail,
  heartbeat,
  registerJobType,
} from "./jobqueue.js";

/**
 * Confluence and Jira each get their OWN scope schema, not one shared union
 * — a single shared schema let a Confluence job accept a Jira-only
 * `project`/`issues` shape (and vice versa), which `predicate()` in
 * scope.ts would then interpret as the WRONG query language (JQL fed to a
 * CQL endpoint or vice versa) instead of being rejected outright. `pages`/
 * `issues` are deliberately excluded from both: they're one-off fetches
 * with no cursor (see cursorKey()) and are not schedulable recurring work
 * in the first place — the guard in schedule*Sync() below rejects them
 * too, but excluding them here means a directly-constructed payload can't
 * bypass that guard either.
 */
const CONFLUENCE_SCOPE_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("space"), key: z.string().min(1) }),
  z.object({ kind: z.literal("query"), q: z.string() }),
]);
type ConfluenceScheduleScope = z.infer<typeof CONFLUENCE_SCOPE_SCHEMA>;

const JIRA_SCOPE_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("project"), key: z.string().min(1) }),
  z.object({ kind: z.literal("query"), q: z.string() }),
]);
type JiraScheduleScope = z.infer<typeof JIRA_SCOPE_SCHEMA>;

export const JOB_TYPE_CONFLUENCE_SYNC = "ingest:confluence";
export const JOB_TYPE_JIRA_SYNC = "ingest:jira";
export const JOB_TYPE_OBSIDIAN_SYNC = "ingest:obsidian";
export const JOB_TYPE_REPO_SYNC = "ingest:repo";

/**
 * None of these four schemas carry a `tenant` field. The queue envelope's
 * own `jobs.tenant` column (validated and stored by enqueue()/claim(),
 * never influenced by payload content) is the ONLY tenant dispatch() ever
 * trusts — see dispatch() below. Earlier versions duplicated `tenant`
 * into the payload and read it back at dispatch time, which meant a
 * directly-enqueued or corrupted payload could carry a DIFFERENT tenant
 * than the envelope and silently write across the tenant boundary.
 */
const CONFLUENCE_SYNC_SCHEMA = z.object({ scope: CONFLUENCE_SCOPE_SCHEMA });
type ConfluenceSyncPayload = z.infer<typeof CONFLUENCE_SYNC_SCHEMA>;

const JIRA_SYNC_SCHEMA = z.object({ scope: JIRA_SCOPE_SCHEMA });
type JiraSyncPayload = z.infer<typeof JIRA_SYNC_SCHEMA>;

const OBSIDIAN_SYNC_SCHEMA = z.object({ vault: z.string().min(1) });
type ObsidianSyncPayload = z.infer<typeof OBSIDIAN_SYNC_SCHEMA>;

const REPO_SYNC_SCHEMA = z.object({
  ref: z.string().min(1),
  kind: z.enum(["git", "bitbucket"]).optional(),
  branch: z.string().optional(),
  subpath: z.string().optional(),
  name: z.string().optional(),
  aclGroups: z.array(z.string()).optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});
type RepoSyncPayload = z.infer<typeof REPO_SYNC_SCHEMA>;

/**
 * Registers the four connector-schedule job types against jobqueue.ts's
 * zod registry. Idempotent (registerJobType is a Map.set) — safe to call
 * from both `eil worker run` and `eil schedule ...`, and safe to call more
 * than once in one process.
 */
export function registerIngestJobTypes(): void {
  registerJobType(JOB_TYPE_CONFLUENCE_SYNC, CONFLUENCE_SYNC_SCHEMA);
  registerJobType(JOB_TYPE_JIRA_SYNC, JIRA_SYNC_SCHEMA);
  registerJobType(JOB_TYPE_OBSIDIAN_SYNC, OBSIDIAN_SYNC_SCHEMA);
  registerJobType(JOB_TYPE_REPO_SYNC, REPO_SYNC_SCHEMA);
}

/**
 * Live clients/sources a dispatching worker needs, injected rather than
 * constructed inline — the same shape `ingestConfluenceScope`/
 * `ingestJiraScope`/`ingestRepo` already require of their callers. Tests
 * inject fakes conforming to `ConfluenceLike`/`JiraLike`/`RepoSource`; `eil
 * worker run` injects the real env-credentialed clients, the same
 * `liveClient()` construction the synchronous CLI path already uses.
 */
export interface IngestClients {
  confluence?: () => ConfluenceLike | Promise<ConfluenceLike>;
  jira?: () => JiraLike | Promise<JiraLike>;
  /** Defaults to the real GitCloneSource/BitbucketApiSource by ref kind. */
  repoSource?: (payload: RepoSyncPayload) => RepoSource | Promise<RepoSource>;
}

class MissingIngestClientError extends Error {
  constructor(jobType: string, field: keyof IngestClients) {
    super(`job type ${jobType} requires an IngestClients.${field} factory, none was configured`);
    this.name = "MissingIngestClientError";
  }
}

/**
 * Dispatches one claimed job to the same pipeline function the synchronous
 * CLI calls. `job.tenant` — the queue envelope, set once by enqueue() and
 * never re-derived from payload content — is the ONLY tenant passed to any
 * ingestion call below. See the schema comment above for why.
 */
async function dispatch(job: Job, clients: IngestClients): Promise<void> {
  switch (job.job_type) {
    case JOB_TYPE_CONFLUENCE_SYNC: {
      const payload = CONFLUENCE_SYNC_SCHEMA.parse(job.payload) as ConfluenceSyncPayload;
      if (!clients.confluence) throw new MissingIngestClientError(job.job_type, "confluence");
      const conf = await clients.confluence();
      await ingestConfluenceScope(conf, payload.scope, job.tenant);
      return;
    }
    case JOB_TYPE_JIRA_SYNC: {
      const payload = JIRA_SYNC_SCHEMA.parse(job.payload) as JiraSyncPayload;
      if (!clients.jira) throw new MissingIngestClientError(job.job_type, "jira");
      const jira = await clients.jira();
      await ingestJiraScope(jira, payload.scope, job.tenant);
      return;
    }
    case JOB_TYPE_OBSIDIAN_SYNC: {
      const payload = OBSIDIAN_SYNC_SCHEMA.parse(job.payload) as ObsidianSyncPayload;
      const docs = walkVault(payload.vault, job.tenant);
      await ingestDocs("obsidian", docs);
      // The vault walk IS a full listing — reconcile deletions every run,
      // exactly like the synchronous `eil ingest obsidian` command does.
      await runReconcile(
        "obsidian",
        async () => ({ ids: docs.map((d) => d.id), complete: true }),
        job.tenant,
      );
      return;
    }
    case JOB_TYPE_REPO_SYNC: {
      const payload = REPO_SYNC_SCHEMA.parse(job.payload) as RepoSyncPayload;
      const kind = payload.kind ?? detectSource(payload.ref);
      const key = repoKey(payload.ref, payload.name);
      const filter = new RepoFilter({
        ...(payload.includes ? { includes: payload.includes } : {}),
        ...(payload.excludes ? { excludes: payload.excludes } : {}),
      });
      const cfg = {
        ref: payload.ref,
        ...(payload.branch ? { branch: payload.branch } : {}),
        ...(payload.subpath ? { subpath: payload.subpath } : {}),
      };
      const source = clients.repoSource
        ? await clients.repoSource(payload)
        : kind === "bitbucket"
          ? new BitbucketApiSource(cfg)
          : new GitCloneSource(cfg);
      await ingestRepo(source, key, payload.subpath, filter, job.tenant, payload.aclGroups ?? []);
      return;
    }
    default:
      throw new Error(`worker.ts has no dispatcher for job type ${job.job_type}`);
  }
}

const DEFAULT_SCHEDULE_WINDOW_MS = 60 * 60 * 1_000; // 1h
const MAX_SCHEDULE_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24h

export class InvalidScheduleOptionError extends Error {
  constructor(field: string, detail: string) {
    super(`invalid ScheduleOptions.${field}: ${detail}`);
    this.name = "InvalidScheduleOptionError";
  }
}

/**
 * Floors `now` to a `windowMs`-wide bucket so repeated scheduling calls
 * within the same window collide on the SAME idempotency key and dedupe to
 * a no-op — the intended behavior for e.g. a cron invoking a schedule
 * command more often than the underlying sync should actually run at. A
 * new window naturally produces a fresh key once it rolls over, whether or
 * not the previous job has finished.
 *
 * `windowMs` and `now` are validated here, before any key is built:
 * `windowMs=0` divides by zero into `Infinity`, and NaN/negative/fractional
 * values propagate into a garbage (or colliding) idempotency key silently —
 * exactly the kind of caller mistake (including a raw `Number(cliFlag)`
 * that didn't parse) that must be rejected up front, not delegated to
 * whatever `Math.floor` happens to produce.
 */
function resolveScheduleWindow(opts: ScheduleOptions): { windowMs: number; now: Date } {
  const windowMs = opts.windowMs ?? DEFAULT_SCHEDULE_WINDOW_MS;
  if (!Number.isFinite(windowMs) || !Number.isInteger(windowMs) || windowMs <= 0) {
    throw new InvalidScheduleOptionError("windowMs", "must be a positive finite integer");
  }
  if (windowMs > MAX_SCHEDULE_WINDOW_MS) {
    throw new InvalidScheduleOptionError("windowMs", `must be at most ${MAX_SCHEDULE_WINDOW_MS}`);
  }
  const now = opts.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidScheduleOptionError("now", "must be a valid Date");
  }
  return { windowMs, now };
}

function scheduleBucket(now: Date, windowMs: number): number {
  return Math.floor(now.getTime() / windowMs);
}

export interface ScheduleOptions {
  windowMs?: number;
  maxAttempts?: number;
  now?: Date;
}

function scheduleEnqueueOptions(opts: ScheduleOptions): EnqueueOptions {
  return opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts };
}

/**
 * Schedules a recurring Confluence sync. Only scopes with a stable
 * `cursorKey` (all/space/project/query) can be scheduled this way — a
 * one-off `pages` fetch has no cursor and is not a "recurring schedule" in
 * the first place; call `ingestConfluenceScope` directly for that.
 */
export async function scheduleConfluenceSync(
  client: Db,
  tenant: string,
  scope: Scope,
  opts: ScheduleOptions = {},
): Promise<Job> {
  const key = cursorKey("confluence", scope);
  if (key === null) {
    throw new Error(
      `scope kind "${scope.kind}" has no stable cursor key and cannot be scheduled recurringly`,
    );
  }
  const { windowMs, now } = resolveScheduleWindow(opts);
  const idempotencyKey = `${key}:${scheduleBucket(now, windowMs)}`;
  return enqueue(
    client,
    tenant,
    JOB_TYPE_CONFLUENCE_SYNC,
    { scope },
    idempotencyKey,
    scheduleEnqueueOptions(opts),
  );
}

export async function scheduleJiraSync(
  client: Db,
  tenant: string,
  scope: Scope,
  opts: ScheduleOptions = {},
): Promise<Job> {
  const key = cursorKey("jira", scope);
  if (key === null) {
    throw new Error(
      `scope kind "${scope.kind}" has no stable cursor key and cannot be scheduled recurringly`,
    );
  }
  const { windowMs, now } = resolveScheduleWindow(opts);
  const idempotencyKey = `${key}:${scheduleBucket(now, windowMs)}`;
  return enqueue(
    client,
    tenant,
    JOB_TYPE_JIRA_SYNC,
    { scope },
    idempotencyKey,
    scheduleEnqueueOptions(opts),
  );
}

export async function scheduleObsidianSync(
  client: Db,
  tenant: string,
  vault: string,
  opts: ScheduleOptions = {},
): Promise<Job> {
  const { windowMs, now } = resolveScheduleWindow(opts);
  const idempotencyKey = `obsidian:${vault}:${scheduleBucket(now, windowMs)}`;
  return enqueue(
    client,
    tenant,
    JOB_TYPE_OBSIDIAN_SYNC,
    { vault },
    idempotencyKey,
    scheduleEnqueueOptions(opts),
  );
}

export async function scheduleRepoSync(
  client: Db,
  tenant: string,
  payload: RepoSyncPayload,
  opts: ScheduleOptions = {},
): Promise<Job> {
  const { windowMs, now } = resolveScheduleWindow(opts);
  const key = repoKey(payload.ref, payload.name);
  const idempotencyKey = `code:${key}:${scheduleBucket(now, windowMs)}`;
  return enqueue(
    client,
    tenant,
    JOB_TYPE_REPO_SYNC,
    payload,
    idempotencyKey,
    scheduleEnqueueOptions(opts),
  );
}

export interface WorkerPoolOptions {
  concurrency?: number;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  batchSize?: number;
  workerIdPrefix?: string;
  clients?: IngestClients;
  onJobError?: (job: Job, err: unknown) => void;
  /** Called when claim() itself fails (e.g. a transient DB error) — the
   *  loop is NOT killed by this; it retries after `pollIntervalMs`. */
  onClaimError?: (err: unknown) => void;
  /** Injectable for deterministic tests — see fail()'s own `random` option. */
  random?: () => number;
}

export interface WorkerPoolHandle {
  /**
   * Stops claiming new work immediately. Any job a worker had already
   * claimed before `stop()` was called is allowed to finish (heartbeating
   * continues until it does); any job in an already-claimed batch that this
   * worker had not yet started is left alone — its lease is not touched, so
   * it simply expires and another worker reclaims it later. `stop()`
   * resolves once every worker loop has wound down.
   */
  stop(): Promise<void>;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS_POOL = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE_POOL = 1;
const MAX_CONCURRENCY = 64;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24h, same bound jobqueue.ts uses for leaseMs
const MAX_BATCH_SIZE_POOL = 1_000; // matches jobqueue.ts's MAX_BATCH_SIZE

export class InvalidWorkerPoolOptionError extends Error {
  constructor(field: string, detail: string) {
    super(`invalid WorkerPoolOptions.${field}: ${detail}`);
    this.name = "InvalidWorkerPoolOptionError";
  }
}

function requirePositiveBoundedInt(field: string, value: number, max: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new InvalidWorkerPoolOptionError(field, "must be a positive finite integer");
  }
  if (value > max) {
    throw new InvalidWorkerPoolOptionError(field, `must be at most ${max}`);
  }
}

/**
 * Starts `concurrency` independent claim loops against the same queue.
 * Each loop: claim up to `batchSize` jobs, run each to completion
 * (heartbeating on an interval well inside `leaseMs` so a lease never
 * lapses under normal operation), then complete()/fail() it — ownership is
 * re-checked atomically by jobqueue.ts on every one of those writes, so a
 * worker that silently lost its lease (heartbeat started returning false)
 * can never have a stale completion mistaken for a real one; this pool
 * additionally skips the write entirely once that's detected, purely to
 * avoid wasted round trips and a misleading last_error, not because
 * skipping is what makes it safe.
 *
 * All lifecycle options are validated synchronously, before any loop
 * starts — a `concurrency: 0` that silently created zero loops while the
 * caller believed the pool was running, or a `heartbeatIntervalMs` at or
 * past `leaseMs` (guaranteeing an avoidable lease loss on every job), fail
 * loudly here instead of misbehaving at runtime.
 */
const MAX_WORKER_ID_PREFIX_LENGTH = 400;

export function startWorkerPool(client: Db, opts: WorkerPoolOptions = {}): WorkerPoolHandle {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  requirePositiveBoundedInt("concurrency", concurrency, MAX_CONCURRENCY);
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS_POOL;
  requirePositiveBoundedInt("leaseMs", leaseMs, MAX_INTERVAL_MS);
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseMs / 3));
  requirePositiveBoundedInt("heartbeatIntervalMs", heartbeatIntervalMs, MAX_INTERVAL_MS);
  if (heartbeatIntervalMs >= leaseMs) {
    throw new InvalidWorkerPoolOptionError(
      "heartbeatIntervalMs",
      `must be less than leaseMs (${heartbeatIntervalMs} >= ${leaseMs}) — otherwise the lease can expire before the first heartbeat ever renews it`,
    );
  }
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  requirePositiveBoundedInt("pollIntervalMs", pollIntervalMs, MAX_INTERVAL_MS);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE_POOL;
  requirePositiveBoundedInt("batchSize", batchSize, MAX_BATCH_SIZE_POOL);
  const clients = opts.clients ?? {};
  const workerIdPrefix = opts.workerIdPrefix ?? `worker-${process.pid}`;
  // An empty/whitespace-only or oversized prefix wouldn't fail synchronously
  // anywhere — every claim() call downstream would just reject on its own
  // workerId validation forever, indistinguishable at a glance from a real
  // outage, well after the CLI has already printed "worker pool running".
  if (typeof workerIdPrefix !== "string" || workerIdPrefix.trim().length === 0) {
    throw new InvalidWorkerPoolOptionError(
      "workerIdPrefix",
      "must be a non-empty, non-whitespace string",
    );
  }
  if (workerIdPrefix.length > MAX_WORKER_ID_PREFIX_LENGTH) {
    throw new InvalidWorkerPoolOptionError(
      "workerIdPrefix",
      `must be at most ${MAX_WORKER_ID_PREFIX_LENGTH} characters`,
    );
  }

  let stopping = false;
  // Aborted once by stop(), so any in-flight `sleepOrStop()` wakes up
  // immediately instead of waiting out the rest of `pollIntervalMs` — up
  // to 24h. A plain `Promise.race([sleep(ms), stopSignal])` would resolve
  // promptly too, but leaves the LOSING `setTimeout` from `sleep(ms)`
  // still scheduled: Node keeps the process (or, for a library caller
  // embedding this pool, the event loop) alive for the rest of that timer
  // regardless of the race's outcome. `sleepOrStop` therefore owns its
  // timer directly and clears it on whichever path resolves first —
  // `{ once: true }` on the abort listener also means a call that wins by
  // timing out cleans up after itself instead of leaving a listener
  // attached to `stopController.signal` for the remainder of the pool's
  // life.
  const stopController = new AbortController();
  function sleepOrStop(ms: number): Promise<void> {
    if (stopController.signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        stopController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      stopController.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A user-supplied callback must never be able to kill the worker loop it reports into. */
  function safeCall<Args extends unknown[]>(
    fn: ((...args: Args) => void) | undefined,
    ...args: Args
  ): void {
    if (!fn) return;
    try {
      fn(...args);
    } catch {
      // deliberately swallowed — see the doc comment above
    }
  }

  async function runOne(workerId: string, job: Job): Promise<void> {
    const fenceToken = job.fence_token;
    let lost = false;
    const hb = setInterval(() => {
      heartbeat(client, job.id, workerId, fenceToken, leaseMs)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, heartbeatIntervalMs);
    try {
      await dispatch(job, clients);
      clearInterval(hb);
      if (lost) return; // no longer the owner — the write would just no-op
      await complete(client, job.id, workerId, fenceToken);
    } catch (err) {
      clearInterval(hb);
      if (!lost) {
        await fail(
          client,
          job.id,
          workerId,
          fenceToken,
          String((err as Error)?.message ?? err),
          opts.random ? { random: opts.random } : {},
        ).catch(() => {});
      }
      safeCall(opts.onJobError, job, err);
    }
  }

  async function loop(index: number): Promise<void> {
    const workerId = `${workerIdPrefix}-${index}`;
    while (!stopping) {
      // claim() itself can fail (a transient DB error, a dropped
      // connection) — this must never kill the loop. An earlier version
      // let that rejection propagate out of loop() entirely: nothing
      // observes that promise until stop() is called, so the pool would
      // silently run with one fewer worker (or produce an unhandled
      // rejection) for as long as it stayed up. Reporting via
      // onClaimError and retrying after pollIntervalMs keeps the loop
      // alive and makes the failure visible instead.
      let jobs: Job[];
      try {
        jobs = await claim(client, workerId, { leaseMs, batchSize });
      } catch (err) {
        safeCall(opts.onClaimError, err);
        await sleepOrStop(pollIntervalMs);
        continue;
      }
      if (jobs.length === 0) {
        await sleepOrStop(pollIntervalMs);
        continue;
      }
      for (const job of jobs) {
        if (stopping) break; // finish nothing new; already-running work below still completes
        await runOne(workerId, job);
      }
    }
  }

  const loops = Array.from({ length: concurrency }, (_, i) => loop(i));

  return {
    async stop() {
      stopping = true;
      stopController.abort();
      await Promise.all(loops);
    },
  };
}
