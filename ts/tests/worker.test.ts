/**
 * F5b end-to-end regressions: the worker pool claiming real jobs off the
 * F5a queue and dispatching them into the EXISTING ingestion pipeline.
 *
 * Real Postgres only, same reasoning as ts/tests/jobqueue.test.ts — FOR
 * UPDATE SKIP LOCKED cannot be exercised on PGlite. Availability is
 * resolved entirely in top-level module code before any describe()
 * registers, for the same describe.skipIf(!available) timing reason.
 *
 * `EIL_DATABASE_URL` is temporarily repointed at this file's own database
 * for its whole lifetime (restored in afterAll) — ts/ingest/pipeline.ts's
 * functions open their OWN connection via the bare `connect()`/dsn()
 * mechanism rather than accepting an injected client, so this is the only
 * way the pipeline's writes land in the same database this file asserts
 * against. vitest.config.ts sets `fileParallelism: false` specifically so
 * this kind of whole-process env override across a file's lifetime is safe.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, connect, migrationFiles, withDatabase } from "../db.js";
import type { ConfluencePage } from "../ingest/confluence.js";
import type { ConfluenceLike } from "../ingest/pipeline.js";
import { InvalidJobPayloadError, enqueue } from "../jobqueue.js";
import {
  InvalidScheduleOptionError,
  InvalidWorkerPoolOptionError,
  JOB_TYPE_CONFLUENCE_SYNC,
  JOB_TYPE_JIRA_SYNC,
  JOB_TYPE_OBSIDIAN_SYNC,
  type WorkerPoolHandle,
  registerIngestJobTypes,
  scheduleConfluenceSync,
  scheduleObsidianSync,
  startWorkerPool,
} from "../worker.js";

async function admin(sqlText: string): Promise<void> {
  const a = await connect("postgres");
  try {
    await a.query(sqlText);
  } finally {
    await a.end();
  }
}

let client: Db;
let clientConnected = false;
let available = true;
const savedUrl = process.env.EIL_DATABASE_URL;
try {
  await admin("DROP DATABASE IF EXISTS eil_ts_worker");
  await admin("CREATE DATABASE eil_ts_worker");
  process.env.EIL_DATABASE_URL = withDatabase(savedUrl ?? "postgresql:///eil", "eil_ts_worker");
  client = await connect();
  clientConnected = true;
  const dbCheck = await client.query("SELECT current_database() AS db");
  if (dbCheck.rows[0].db !== "eil_ts_worker")
    throw new Error(`wrong database: ${dbCheck.rows[0].db}`);
  for (const { sql } of migrationFiles()) await client.query(sql);
} catch {
  available = false;
}

// Unconditional and truthful regardless of `available`: a bootstrap
// failure AFTER EIL_DATABASE_URL was already repointed (e.g. CREATE
// DATABASE succeeded but a later migration didn't) must still restore the
// env var and drop whatever got created — an early `if (!available) return`
// here would leave EIL_DATABASE_URL pointed at eil_ts_worker for every
// later test file in the same (fileParallelism: false) run, and leak the
// half-built database in the cluster.
afterAll(async () => {
  if (clientConnected) await client.end().catch(() => {});
  // `process.env.X = undefined` stringifies to the literal "undefined"
  // rather than leaving the var unset — if EIL_DATABASE_URL genuinely
  // wasn't set before this file ran, that would poison dsn() for every
  // later test file in the same (fileParallelism: false) run.
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  await admin("DROP DATABASE IF EXISTS eil_ts_worker WITH (FORCE)").catch(() => {});
});

beforeAll(() => {
  registerIngestJobTypes();
});

afterEach(async () => {
  if (!available) return;
  await client.query("DELETE FROM jobs");
  await client.query("DELETE FROM documents");
  await client.query("DELETE FROM sync_cursors");
});

async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met within timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function jobStatus(id: string): Promise<string> {
  const res = await client.query("SELECT status FROM jobs WHERE id = $1", [id]);
  if (res.rows.length === 0) throw new Error(`no job ${id}`);
  return res.rows[0].status;
}

/** A controllable fake ConfluenceLike — no network, deterministic failures/gating. */
class FakeConfluence implements ConfluenceLike {
  calls = 0;
  constructor(
    private opts: {
      failFirstNCalls?: number;
      gate?: Promise<void>;
      pages?: ConfluencePage[];
    } = {},
  ) {}
  async *updatedSince(): AsyncGenerator<ConfluencePage> {
    this.calls++;
    if (this.opts.gate) await this.opts.gate;
    if (this.opts.failFirstNCalls && this.calls <= this.opts.failFirstNCalls) {
      throw new Error(`simulated transient failure (call ${this.calls})`);
    }
    for (const p of this.opts.pages ?? []) yield p;
  }
  async getPage(id: string): Promise<ConfluencePage> {
    throw new Error(`getPage(${id}) not used by this fake`);
  }
  async *descendants(): AsyncGenerator<ConfluencePage> {}
}

function makeVault(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "eil-worker-vault-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf-8");
  return dir;
}

const CONFLUENCE_PAGE: ConfluencePage = {
  id: "1",
  title: "Runbook",
  body: "hello world",
  updated: "2026-01-01T00:00:00Z",
};

let pools: WorkerPoolHandle[] = [];
afterEach(async () => {
  await Promise.all(pools.map((p) => p.stop()));
  pools = [];
});

describe.skipIf(!available)("worker pool — success and tenant propagation", () => {
  it("processes an obsidian-sync job end to end and ingests the vault under the right tenant", async () => {
    const vault = makeVault({ "note.md": "# Hello\n\nSome content." });
    try {
      const job = await scheduleObsidianSync(client, "tenant-omega", vault);
      const pool = startWorkerPool(client, { concurrency: 1, leaseMs: 5_000, pollIntervalMs: 30 });
      pools.push(pool);

      await waitFor(async () => (await jobStatus(job.id)) === "completed");

      const docs = await client.query("SELECT id, tenant FROM documents WHERE tenant = $1", [
        "tenant-omega",
      ]);
      expect(docs.rows.length).toBe(1);
      expect(docs.rows[0].tenant).toBe("tenant-omega");

      const otherTenant = await client.query("SELECT id FROM documents WHERE tenant = $1", [
        "some-other-tenant",
      ]);
      expect(otherTenant.rows.length).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("a payload's stray tenant field cannot override the queue envelope's tenant", async () => {
    // Simulates a directly-enqueued or foreign-written job whose raw JSON
    // payload carries a tenant disagreeing with the queue envelope's own
    // `jobs.tenant` column — bypasses enqueue()'s zod schema (which no
    // longer even has a tenant field to smuggle) to prove dispatch() only
    // ever trusts job.tenant, not anything found inside job.payload.
    const vault = makeVault({ "note.md": "# X\n\nspoof-proof content." });
    try {
      const inserted = await client.query(
        `INSERT INTO jobs (tenant, job_type, payload, idempotency_key)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          "tenant-real",
          JOB_TYPE_OBSIDIAN_SYNC,
          JSON.stringify({ vault, tenant: "tenant-spoofed" }),
          "spoof-key",
        ],
      );
      const jobId = inserted.rows[0].id;

      const pool = startWorkerPool(client, { concurrency: 1, leaseMs: 5_000, pollIntervalMs: 30 });
      pools.push(pool);
      await waitFor(async () => (await jobStatus(jobId)) === "completed");

      const real = await client.query("SELECT id FROM documents WHERE tenant = $1", [
        "tenant-real",
      ]);
      expect(real.rows.length).toBe(1);
      const spoofed = await client.query("SELECT id FROM documents WHERE tenant = $1", [
        "tenant-spoofed",
      ]);
      expect(spoofed.rows.length).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("re-processing an unchanged vault (new schedule window) does not duplicate or rewrite documents", async () => {
    const vault = makeVault({ "note.md": "# Hello\n\nStable content." });
    try {
      const job1 = await scheduleObsidianSync(client, "t1", vault, { now: new Date(0) });
      const pool = startWorkerPool(client, { concurrency: 1, leaseMs: 5_000, pollIntervalMs: 30 });
      pools.push(pool);
      await waitFor(async () => (await jobStatus(job1.id)) === "completed");

      const before = await client.query(
        "SELECT id, revision FROM documents WHERE tenant = 't1' ORDER BY id",
      );
      expect(before.rows.length).toBe(1);

      // A different schedule window (a full window later) produces a
      // genuinely new job — proving this isn't testing idempotency-key
      // dedup, but the pipeline's own content hash gate.
      const job2 = await scheduleObsidianSync(client, "t1", vault, {
        now: new Date(60 * 60 * 1_000),
      });
      expect(job2.id).not.toBe(job1.id);
      await waitFor(async () => (await jobStatus(job2.id)) === "completed");

      const after = await client.query(
        "SELECT id, revision FROM documents WHERE tenant = 't1' ORDER BY id",
      );
      expect(after.rows.length).toBe(1);
      expect(after.rows[0].revision).toBe(before.rows[0].revision); // hash-gated: no rewrite
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!available)("worker pool — retry, crash/reclaim, fencing", () => {
  it("retries a job whose first attempt fails and completes on the second, via the pool's own claim/heartbeat/fail cycle", async () => {
    const fake = new FakeConfluence({ failFirstNCalls: 1, pages: [CONFLUENCE_PAGE] });
    const job = await enqueue(
      client,
      "t1",
      JOB_TYPE_CONFLUENCE_SYNC,
      { tenant: "t1", scope: { kind: "all" } },
      "retry-key",
      { maxAttempts: 3 },
    );

    const pool = startWorkerPool(client, {
      concurrency: 1,
      leaseMs: 5_000,
      pollIntervalMs: 30,
      random: () => 0, // zero backoff — the retry is near-instant, not flaky-slow
      clients: { confluence: () => fake },
    });
    pools.push(pool);

    await waitFor(async () => (await jobStatus(job.id)) === "completed", { timeoutMs: 5_000 });
    expect(fake.calls).toBe(2);

    const row = await client.query("SELECT attempts FROM jobs WHERE id = $1", [job.id]);
    expect(row.rows[0].attempts).toBe(2);
  });

  it("reclaims a job a crashed worker never finished, and the live pool completes it", async () => {
    const fake = new FakeConfluence({ pages: [CONFLUENCE_PAGE] });
    const job = await enqueue(
      client,
      "t1",
      JOB_TYPE_CONFLUENCE_SYNC,
      { tenant: "t1", scope: { kind: "all" } },
      "crash-key",
    );

    // Simulate a worker that claimed the job and then died: claim it
    // directly (bypassing the pool entirely) with a short lease, and never
    // heartbeat/complete/fail it.
    const { claim } = await import("../jobqueue.js");
    const [claimed] = await claim(client, "worker-that-crashed", { leaseMs: 50 });
    if (!claimed) throw new Error("expected the job to be claimed");
    await new Promise((r) => setTimeout(r, 150)); // let the 50ms lease expire

    const pool = startWorkerPool(client, {
      concurrency: 1,
      leaseMs: 5_000,
      pollIntervalMs: 30,
      clients: { confluence: () => fake },
    });
    pools.push(pool);

    await waitFor(async () => (await jobStatus(job.id)) === "completed");
    expect(fake.calls).toBe(1); // the crashed worker's claim never actually ran dispatch()
  });
});

describe.skipIf(!available)("worker pool — graceful shutdown", () => {
  it("stop() claims no new work and waits for the in-flight job to finish before returning", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const fake = new FakeConfluence({ gate });

    const jobA = await enqueue(
      client,
      "t1",
      JOB_TYPE_CONFLUENCE_SYNC,
      { tenant: "t1", scope: { kind: "all" } },
      "shutdown-key-a",
    );
    const jobB = await enqueue(
      client,
      "t1",
      JOB_TYPE_CONFLUENCE_SYNC,
      { tenant: "t1", scope: { kind: "space", key: "OTHER" } },
      "shutdown-key-b",
    );

    const pool = startWorkerPool(client, {
      concurrency: 1,
      leaseMs: 5_000,
      pollIntervalMs: 20,
      clients: { confluence: () => fake },
    });

    await waitFor(async () => (await jobStatus(jobA.id)) === "claimed");
    const stopPromise = pool.stop();

    // Give the (now-stopping) pool a moment it could have wrongly used to
    // claim jobB — it must not, even though it's sitting there ready.
    await new Promise((r) => setTimeout(r, 100));
    expect(await jobStatus(jobB.id)).toBe("pending");
    expect(await jobStatus(jobA.id)).toBe("claimed"); // still in flight, not abandoned

    releaseGate();
    await stopPromise;

    expect(await jobStatus(jobA.id)).toBe("completed");
    expect(await jobStatus(jobB.id)).toBe("pending"); // left alone, reclaimable by the next pool
  });
});

describe.skipIf(!available)("worker pool — duplicate scheduling", () => {
  it("scheduling the same sync twice within one window returns the same job, not a duplicate", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const first = await scheduleConfluenceSync(client, "t1", { kind: "all" }, { now });
    const second = await scheduleConfluenceSync(client, "t1", { kind: "all" }, { now });
    expect(second.id).toBe(first.id);

    const count = await client.query("SELECT count(*)::int AS n FROM jobs WHERE job_type = $1", [
      JOB_TYPE_CONFLUENCE_SYNC,
    ]);
    expect(count.rows[0].n).toBe(1);
  });

  it("scheduling in a later window produces a new job", async () => {
    const windowMs = 60 * 60 * 1_000;
    const first = await scheduleConfluenceSync(
      client,
      "t1",
      { kind: "all" },
      { now: new Date(0), windowMs },
    );
    const second = await scheduleConfluenceSync(
      client,
      "t1",
      { kind: "all" },
      { now: new Date(windowMs), windowMs },
    );
    expect(second.id).not.toBe(first.id);
  });

  it("refuses to schedule a one-off scope with no stable cursor key", async () => {
    await expect(
      scheduleConfluenceSync(client, "t1", { kind: "pages", ids: ["1"], withDescendants: false }),
    ).rejects.toThrow(/no stable cursor key/);
  });

  it("rejects an invalid windowMs before building any idempotency key", async () => {
    // windowMs=0 would divide-by-zero into Infinity; negative/NaN/fractional
    // values are equally nonsensical bucket widths — all must be rejected
    // synchronously, matching what a raw `Number(cliFlag)` can produce.
    for (const bad of [0, -1, Number.NaN, 1.5, 25 * 60 * 60 * 1_000]) {
      await expect(
        scheduleConfluenceSync(client, "t1", { kind: "all" }, { windowMs: bad }),
      ).rejects.toThrow(InvalidScheduleOptionError);
    }
  });

  it("rejects an invalid `now`", async () => {
    await expect(
      scheduleConfluenceSync(client, "t1", { kind: "all" }, { now: new Date(Number.NaN) }),
    ).rejects.toThrow(InvalidScheduleOptionError);
  });
});

describe.skipIf(!available)("worker pool — per-job-type scope schema validation", () => {
  it("rejects a Jira-shaped scope (project) in a confluence-sync payload", async () => {
    await expect(
      enqueue(
        client,
        "t1",
        JOB_TYPE_CONFLUENCE_SYNC,
        { scope: { kind: "project", key: "X" } },
        "bad-scope-key-1",
      ),
    ).rejects.toThrow(InvalidJobPayloadError);
  });

  it("rejects a Confluence-shaped scope (space) in a jira-sync payload", async () => {
    await expect(
      enqueue(
        client,
        "t1",
        JOB_TYPE_JIRA_SYNC,
        { scope: { kind: "space", key: "X" } },
        "bad-scope-key-2",
      ),
    ).rejects.toThrow(InvalidJobPayloadError);
  });

  it("rejects a one-off pages/issues scope even if directly enqueued (bypassing the schedule*Sync guard)", async () => {
    await expect(
      enqueue(
        client,
        "t1",
        JOB_TYPE_CONFLUENCE_SYNC,
        { scope: { kind: "pages", ids: ["1"], withDescendants: false } },
        "bad-scope-key-3",
      ),
    ).rejects.toThrow(InvalidJobPayloadError);
  });
});

describe("worker pool — option validation and claim-failure containment", () => {
  // Deliberately not real-Postgres-gated: option validation and the fake
  // always-failing Db below never touch a real connection.
  const fakeClient: Db = {
    query: async () => ({ rows: [] }),
    end: async () => {},
  };

  it("rejects invalid concurrency/lease/interval/batchSize options synchronously, before any loop starts", () => {
    expect(() => startWorkerPool(fakeClient, { concurrency: 0 })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    expect(() => startWorkerPool(fakeClient, { concurrency: -1 })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    expect(() => startWorkerPool(fakeClient, { concurrency: Number.NaN })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    expect(() => startWorkerPool(fakeClient, { leaseMs: 0 })).toThrow(InvalidWorkerPoolOptionError);
    expect(() => startWorkerPool(fakeClient, { pollIntervalMs: -5 })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    expect(() => startWorkerPool(fakeClient, { batchSize: 1.5 })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    // heartbeatIntervalMs must be strictly less than leaseMs.
    expect(() =>
      startWorkerPool(fakeClient, { leaseMs: 1_000, heartbeatIntervalMs: 1_000 }),
    ).toThrow(InvalidWorkerPoolOptionError);
    expect(() =>
      startWorkerPool(fakeClient, { leaseMs: 1_000, heartbeatIntervalMs: 2_000 }),
    ).toThrow(InvalidWorkerPoolOptionError);
  });

  it("rejects an empty/whitespace-only or oversized workerIdPrefix synchronously", () => {
    // An invalid prefix wouldn't fail anywhere else — every claim() call
    // would just reject on its own workerId validation forever, well after
    // the caller believes the pool started successfully.
    expect(() => startWorkerPool(fakeClient, { workerIdPrefix: "" })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    expect(() => startWorkerPool(fakeClient, { workerIdPrefix: "   " })).toThrow(
      InvalidWorkerPoolOptionError,
    );
    expect(() => startWorkerPool(fakeClient, { workerIdPrefix: "x".repeat(401) })).toThrow(
      InvalidWorkerPoolOptionError,
    );
  });

  it("contains a claim() failure — the loop retries after pollIntervalMs and reports it, instead of dying silently", async () => {
    let claimErrors = 0;
    const brokenClient: Db = {
      query: async () => {
        throw new Error("simulated claim failure");
      },
      end: async () => {},
    };
    const pool = startWorkerPool(brokenClient, {
      concurrency: 1,
      pollIntervalMs: 20,
      onClaimError: () => {
        claimErrors++;
      },
    });
    const deadline = Date.now() + 2_000;
    while (claimErrors < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(claimErrors).toBeGreaterThanOrEqual(3);
    await pool.stop(); // must resolve cleanly — the loop is still alive, not dead/rejected
  });

  it("a throwing onClaimError callback does not stop the loop from retrying", async () => {
    let claimAttempts = 0;
    const brokenClient: Db = {
      query: async () => {
        claimAttempts++;
        throw new Error("simulated claim failure");
      },
      end: async () => {},
    };
    const pool = startWorkerPool(brokenClient, {
      concurrency: 1,
      pollIntervalMs: 20,
      onClaimError: () => {
        throw new Error("reporter itself is broken");
      },
    });
    const deadline = Date.now() + 2_000;
    while (claimAttempts < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(claimAttempts).toBeGreaterThanOrEqual(3);
    await pool.stop();
  });

  it("stop() resolves promptly even while a loop is idle-sleeping through a long pollIntervalMs", async () => {
    const pool = startWorkerPool(fakeClient, { concurrency: 1, pollIntervalMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20)); // let the loop enter its sleep
    const start = Date.now();
    await pool.stop();
    expect(Date.now() - start).toBeLessThan(1_000); // nowhere near the 10s poll interval
  });

  it("stop() resolves promptly even while a loop is sleeping off a claim() error through a long pollIntervalMs", async () => {
    const brokenClient: Db = {
      query: async () => {
        throw new Error("simulated claim failure");
      },
      end: async () => {},
    };
    const pool = startWorkerPool(brokenClient, { concurrency: 1, pollIntervalMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20)); // let the loop hit the error and enter its sleep
    const start = Date.now();
    await pool.stop();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("stop() cancels the pending poll timer instead of merely outracing it", async () => {
    // A plain Promise.race([sleep(ms), stopSignal]) also resolves stop()
    // promptly (the two tests above would pass either way) — that alone
    // doesn't prove the LOSING setTimeout was ever cleared. Fake timers
    // make the leaked timer observable directly: with a 24h poll interval,
    // if stop() only outraced it, vi.getTimerCount() would still report it
    // as pending afterward.
    vi.useFakeTimers();
    try {
      const pool = startWorkerPool(fakeClient, {
        concurrency: 1,
        pollIntervalMs: 24 * 60 * 60 * 1_000,
      });
      await vi.advanceTimersByTimeAsync(0); // let the loop's claim() resolve and register its poll timer
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await pool.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
