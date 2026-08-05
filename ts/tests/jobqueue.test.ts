/**
 * Real-Postgres concurrency regressions for the job queue primitive.
 *
 * PGlite is one in-process connection and cannot represent two concurrent
 * workers racing FOR UPDATE SKIP LOCKED — these tests genuinely require
 * real Postgres and skip (never silently pass) when one is unavailable,
 * the same pattern ts/tests/metrics.test.ts and ts/tests/pglite.test.ts
 * already use. Do not treat a skip here as proof of concurrency safety.
 *
 * Availability is fully resolved at module top level, before any
 * describe.skipIf() is evaluated — vitest decides skipIf synchronously at
 * describe-registration time, which runs before any beforeAll hook. A
 * probe that only checks "can I reach Postgres at all" and defers
 * "can I actually create the test database" to beforeAll would let
 * `available` flip to false too late: describe.skipIf would have already
 * committed to running the tests against a database that was never
 * created.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Db, connect, migrationFiles } from "../db.js";
import {
  IdempotencyConflictError,
  InvalidJobPayloadError,
  InvalidJobQueueArgumentError,
  SecretInPayloadError,
  UnknownJobTypeError,
  _clearJobTypesForTests,
  claim,
  complete,
  enqueue,
  fail,
  heartbeat,
  registerJobType,
  replay,
  scrubJobError,
} from "../jobqueue.js";

const FIXTURE_SCHEMA = z.object({ docId: z.string() });

async function admin(sqlText: string): Promise<void> {
  const a = await connect("postgres");
  try {
    await a.query(sqlText);
  } finally {
    await a.end();
  }
}

let client: Db;
let available = true;
try {
  await admin("DROP DATABASE IF EXISTS eil_ts_jobqueue");
  await admin("CREATE DATABASE eil_ts_jobqueue");
  client = await connect("eil_ts_jobqueue");
  const dbCheck = await client.query("SELECT current_database() AS db");
  if (dbCheck.rows[0].db !== "eil_ts_jobqueue")
    throw new Error(`wrong database: ${dbCheck.rows[0].db}`);
  for (const { sql } of migrationFiles()) await client.query(sql);
} catch {
  available = false;
}

afterAll(async () => {
  if (!available) return;
  await client.end();
  await admin("DROP DATABASE eil_ts_jobqueue WITH (FORCE)");
});

beforeAll(() => {
  registerJobType("fixture", FIXTURE_SCHEMA);
});

afterEach(async () => {
  if (!available) return;
  await client.query("DELETE FROM jobs");
});

describe.skipIf(!available)("job queue — enqueue and idempotency", () => {
  it("enqueues and claims a job through to completion", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:1" }, "key-1");
    expect(job.status).toBe("pending");

    const claimed = await claim(client, "worker-a", { batchSize: 10 });
    expect(claimed.map((j) => j.id)).toContain(job.id);
    const mine = claimed.find((j) => j.id === job.id)!;
    expect(mine.status).toBe("claimed");
    expect(mine.fence_token).toBe("1");
    expect(mine.attempts).toBe(1);

    const ok = await complete(client, mine.id, "worker-a", mine.fence_token);
    expect(ok).toBe(true);

    const after = await client.query(
      "SELECT status, lease_owner, lease_expires_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(after.rows[0].status).toBe("completed");
    expect(after.rows[0].lease_owner).toBeNull();
    expect(after.rows[0].lease_expires_at).toBeNull();
  });

  it("duplicate enqueue with the same (tenant, key, type, payload) returns the existing job", async () => {
    const first = await enqueue(client, "t1", "fixture", { docId: "doc:1" }, "dup-key");
    const second = await enqueue(client, "t1", "fixture", { docId: "doc:1" }, "dup-key");
    expect(second.id).toBe(first.id);

    const count = await client.query(
      "SELECT count(*)::int AS n FROM jobs WHERE tenant = 't1' AND idempotency_key = 'dup-key'",
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("rejects reuse of a key with a different payload as a conflict, not a silent alias", async () => {
    await enqueue(client, "t1", "fixture", { docId: "doc:1" }, "conflict-key");
    await expect(
      enqueue(client, "t1", "fixture", { docId: "doc:DIFFERENT" }, "conflict-key"),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("rejects reuse of a key with a different job type as a conflict", async () => {
    registerJobType("fixture-b", FIXTURE_SCHEMA);
    await enqueue(client, "t1", "fixture", { docId: "doc:1" }, "conflict-key-2");
    await expect(
      enqueue(client, "t1", "fixture-b", { docId: "doc:1" }, "conflict-key-2"),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("the same idempotency key does not collide across two different tenants", async () => {
    const a = await enqueue(client, "tenant-a", "fixture", { docId: "doc:1" }, "shared-key");
    const b = await enqueue(client, "tenant-b", "fixture", { docId: "doc:1" }, "shared-key");
    expect(a.id).not.toBe(b.id);
  });

  it("rejects reuse of a key with the same payload but a different maxAttempts as a conflict", async () => {
    await enqueue(client, "t1", "fixture", { docId: "doc:1" }, "attempts-key", { maxAttempts: 3 });
    await expect(
      enqueue(client, "t1", "fixture", { docId: "doc:1" }, "attempts-key", { maxAttempts: 5 }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("rejects an unregistered job type", async () => {
    await expect(enqueue(client, "t1", "no-such-type", {}, "k")).rejects.toThrow(
      UnknownJobTypeError,
    );
  });

  it("rejects a payload that fails its registered schema", async () => {
    await expect(enqueue(client, "t1", "fixture", { wrongField: 1 }, "k")).rejects.toThrow(
      InvalidJobPayloadError,
    );
  });

  it("rejects a payload that looks like it carries a credential", async () => {
    await expect(
      enqueue(client, "t1", "fixture", { docId: "AKIAIOSFODNN7EXAMPLE" }, "k"),
    ).rejects.toThrow(SecretInPayloadError);
  });

  it("rejects a payload that doesn't serialize to a JSON value", async () => {
    registerJobType("raw", z.any());
    // A top-level function/undefined makes JSON.stringify return undefined
    // rather than throw — schema validation alone (z.any()) does not rule
    // this out, so it must be caught after parsing, before it reaches SQL.
    await expect(enqueue(client, "t1", "raw", () => {}, "k-fn")).rejects.toThrow(
      InvalidJobPayloadError,
    );
    // A circular reference makes JSON.stringify throw outright.
    const circular: any = {};
    circular.self = circular;
    await expect(enqueue(client, "t1", "raw", circular, "k-circular")).rejects.toThrow(
      InvalidJobPayloadError,
    );
  });

  it("treats key order as insignificant when comparing payload intent", async () => {
    registerJobType("raw", z.any());
    const first = await enqueue(client, "t1", "raw", { a: 1, b: 2 }, "key-order");
    const second = await enqueue(client, "t1", "raw", { b: 2, a: 1 }, "key-order");
    expect(second.id).toBe(first.id);
  });
});

describe.skipIf(!available)("job queue — input validation", () => {
  it("rejects empty tenant, job type, idempotency key", async () => {
    await expect(enqueue(client, "", "fixture", { docId: "d" }, "k")).rejects.toThrow(
      InvalidJobQueueArgumentError,
    );
    await expect(enqueue(client, "t1", "", { docId: "d" }, "k")).rejects.toThrow(
      InvalidJobQueueArgumentError,
    );
    await expect(enqueue(client, "t1", "fixture", { docId: "d" }, "")).rejects.toThrow(
      InvalidJobQueueArgumentError,
    );
  });

  it("rejects whitespace-only tenant/jobType/idempotencyKey/workerId", async () => {
    await expect(enqueue(client, "   ", "fixture", { docId: "d" }, "k")).rejects.toThrow(
      InvalidJobQueueArgumentError,
    );
    await expect(enqueue(client, "t1", "\t", { docId: "d" }, "k")).rejects.toThrow(
      InvalidJobQueueArgumentError,
    );
    await expect(enqueue(client, "t1", "fixture", { docId: "d" }, "\n")).rejects.toThrow(
      InvalidJobQueueArgumentError,
    );
    await expect(claim(client, "  ")).rejects.toThrow(InvalidJobQueueArgumentError);
  });

  it("rejects a jobId or fenceToken that isn't a canonical positive bigint string", async () => {
    for (const bad of ["abc", "0", "-1", "01", "1.5", "", " ", "9223372036854775808"]) {
      await expect(heartbeat(client, bad, "worker-a", "1")).rejects.toThrow(
        InvalidJobQueueArgumentError,
      );
      await expect(complete(client, bad, "worker-a", "1")).rejects.toThrow(
        InvalidJobQueueArgumentError,
      );
      await expect(complete(client, "1", "worker-a", bad)).rejects.toThrow(
        InvalidJobQueueArgumentError,
      );
      await expect(fail(client, bad, "worker-a", "1", "err")).rejects.toThrow(
        InvalidJobQueueArgumentError,
      );
      await expect(replay(client, bad)).rejects.toThrow(InvalidJobQueueArgumentError);
    }
  });

  it("rejects an invalid runAfter", async () => {
    await expect(
      enqueue(client, "t1", "fixture", { docId: "d" }, "k", { runAfter: new Date(Number.NaN) }),
    ).rejects.toThrow(InvalidJobQueueArgumentError);
  });

  it("rejects non-positive, non-finite, or oversized maxAttempts", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 10_000]) {
      await expect(
        enqueue(client, "t1", "fixture", { docId: "d" }, `k-${bad}`, { maxAttempts: bad }),
      ).rejects.toThrow(InvalidJobQueueArgumentError);
    }
  });

  it("rejects non-positive, non-finite, or oversized batchSize and leaseMs on claim", async () => {
    for (const bad of [0, -1, Number.NaN, 1.5, 100_000]) {
      await expect(claim(client, "worker-a", { batchSize: bad })).rejects.toThrow(
        InvalidJobQueueArgumentError,
      );
    }
    // leaseMs shares the same non-positive/non-finite cases, but its own
    // upper bound is 24h — 100_000ms (100s) is a valid lease, not oversized.
    for (const bad of [0, -1, Number.NaN, 1.5, 25 * 60 * 60 * 1_000]) {
      await expect(claim(client, "worker-a", { leaseMs: bad })).rejects.toThrow(
        InvalidJobQueueArgumentError,
      );
    }
  });

  it("rejects an empty workerId on claim/heartbeat/complete/fail", async () => {
    await expect(claim(client, "")).rejects.toThrow(InvalidJobQueueArgumentError);
    await expect(heartbeat(client, "1", "", "1")).rejects.toThrow(InvalidJobQueueArgumentError);
    await expect(complete(client, "1", "", "1")).rejects.toThrow(InvalidJobQueueArgumentError);
    await expect(fail(client, "1", "", "1", "err")).rejects.toThrow(InvalidJobQueueArgumentError);
  });
});

describe.skipIf(!available)("job queue — concurrency (requires real Postgres)", () => {
  it("two workers claiming concurrently never claim the same job", async () => {
    const n = 20;
    for (let i = 0; i < n; i++) {
      await enqueue(client, "t1", "fixture", { docId: `doc:${i}` }, `concurrent-${i}`);
    }

    // Two genuinely separate connections, so the race is a real Postgres
    // race — not two sequential calls on one connection that could never
    // collide regardless of whether SKIP LOCKED works.
    const clientA = await connect("eil_ts_jobqueue");
    const clientB = await connect("eil_ts_jobqueue");
    try {
      const [batchA, batchB] = await Promise.all([
        claim(clientA, "worker-a", { batchSize: n }),
        claim(clientB, "worker-b", { batchSize: n }),
      ]);
      const idsA = new Set(batchA.map((j) => j.id));
      const idsB = new Set(batchB.map((j) => j.id));
      const overlap = [...idsA].filter((id) => idsB.has(id));
      expect(overlap).toEqual([]);
      expect(idsA.size + idsB.size).toBe(n);
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  it("a rolled-back claim releases the row for another connection to claim", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:tx" }, "tx-key");
    await client.query("BEGIN");
    try {
      const claimed = await claim(client, "worker-tx", { batchSize: 10 });
      expect(claimed.some((j) => j.id === job.id)).toBe(true);
    } finally {
      await client.query("ROLLBACK");
    }

    const clientB = await connect("eil_ts_jobqueue");
    try {
      const claimedAfterRollback = await claim(clientB, "worker-after-rollback", { batchSize: 10 });
      expect(claimedAfterRollback.some((j) => j.id === job.id)).toBe(true);
    } finally {
      await clientB.end();
    }
  });

  it("reclaims an expired lease with a fresh fence_token, and the stale worker's writes are rejected", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:x" }, "lease-key");
    const [firstClaim] = await claim(client, "worker-stale", { leaseMs: 50 });
    if (!firstClaim) throw new Error("expected a claimed job");
    expect(firstClaim.fence_token).toBe("1");

    await new Promise((r) => setTimeout(r, 120)); // let the 50ms lease expire

    const [reclaimed] = await claim(client, "worker-new", { leaseMs: 60_000 });
    if (!reclaimed) throw new Error("expected the lease to be reclaimed");
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.fence_token).toBe("2"); // fresh token, not the stale worker's

    // The stale worker still thinks it holds worker-stale/fence_token "1"
    // and tries to finish the job — this must fail on every write, because
    // worker-new now owns it.
    expect(await complete(client, job.id, "worker-stale", firstClaim.fence_token)).toBe(false);
    expect(await heartbeat(client, job.id, "worker-stale", firstClaim.fence_token)).toBe(false);
    expect(await fail(client, job.id, "worker-stale", firstClaim.fence_token, "err")).toBeNull();

    // The new owner's writes succeed with its own identity.
    expect(await complete(client, job.id, "worker-new", reclaimed.fence_token)).toBe(true);
  });

  it("rejects writes once the lease has expired, even before anyone reclaims it", async () => {
    // The gap this closes: fence_token alone does not encode expiry, so a
    // write that only checked fence_token + status would still succeed
    // here even though the system already considers this lease available.
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:expiry" }, "expiry-key");
    const [claimed] = await claim(client, "worker-a", { leaseMs: 50 });
    if (!claimed) throw new Error("expected a claimed job");

    await new Promise((r) => setTimeout(r, 120)); // let the lease expire; nobody reclaims

    expect(await heartbeat(client, job.id, "worker-a", claimed.fence_token)).toBe(false);
    expect(await complete(client, job.id, "worker-a", claimed.fence_token)).toBe(false);
    expect(await fail(client, job.id, "worker-a", claimed.fence_token, "err")).toBeNull();
  });

  it("a fence_token that matches but a worker id that doesn't is still rejected", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:owner" }, "owner-key");
    const [claimed] = await claim(client, "worker-real");
    if (!claimed) throw new Error("expected a claimed job");
    expect(await complete(client, job.id, "worker-impostor", claimed.fence_token)).toBe(false);
  });

  it("returns a claimed batch ordered by (run_after, id), not RETURNING's unspecified order", async () => {
    // Insert out of id order relative to run_after so an id-only ordering
    // (or no ordering at all) would not accidentally look correct.
    const later = await enqueue(client, "t1", "fixture", { docId: "doc:order-c" }, "order-key-c", {
      runAfter: new Date(Date.now() + 2_000),
    });
    const earliest = await enqueue(
      client,
      "t1",
      "fixture",
      { docId: "doc:order-a" },
      "order-key-a",
    );
    const middle = await enqueue(client, "t1", "fixture", { docId: "doc:order-b" }, "order-key-b");
    // Make `later` claimable too, but only after the other two by run_after.
    await client.query("UPDATE jobs SET run_after = now() WHERE id = $1", [later.id]);

    const claimed = await claim(client, "worker-order", { batchSize: 10 });
    const orderedIds = claimed
      .filter((j) => [earliest.id, middle.id, later.id].includes(j.id))
      .map((j) => j.id);
    expect(orderedIds).toEqual([earliest.id, middle.id, later.id]);
  });

  it("fail() called inside the caller's own transaction is undone by the caller's rollback", async () => {
    // fail() must not issue its own BEGIN/COMMIT/ROLLBACK — if it did, a
    // caller-managed transaction wrapping it would be silently committed
    // or destroyed instead of behaving like any other statement inside it.
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:fail-tx" }, "fail-tx-key");
    const [claimed] = await claim(client, "worker-tx");
    if (!claimed) throw new Error("expected a claimed job");

    await client.query("BEGIN");
    try {
      const result = await fail(client, job.id, "worker-tx", claimed.fence_token, "boom", {
        random: () => 0.5,
      });
      expect(result).toEqual({ status: "pending" });
    } finally {
      await client.query("ROLLBACK");
    }

    // The caller discarded fail()'s write — the job must still look
    // exactly as claim() left it: claimed, owned by worker-tx, same fence.
    const row = await client.query(
      "SELECT status, lease_owner, fence_token FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(row.rows[0].status).toBe("claimed");
    expect(row.rows[0].lease_owner).toBe("worker-tx");
    expect(row.rows[0].fence_token).toBe(claimed.fence_token);
  });

  it("exhausted expired leases sorted ahead of ready work do not consume the claim batch", async () => {
    // An earlier version decided grant-vs-dead-letter per candidate AFTER
    // applying LIMIT, so a run of exhausted expired leases sorted first
    // could consume the entire requested batch on dead-lettering alone,
    // starving ready pending work sitting immediately behind them.
    const exhausted = await enqueue(
      client,
      "t1",
      "fixture",
      { docId: "doc:exhausted" },
      "hol-exhausted-key",
      { maxAttempts: 1 },
    );
    const [claimedExhausted] = await claim(client, "worker-exhaust", { leaseMs: 50 });
    if (!claimedExhausted) throw new Error("expected the exhausted job to be claimed first");
    await new Promise((r) => setTimeout(r, 120)); // expire the lease; attempts(1) >= maxAttempts(1)

    // Enqueued after, so by (run_after, id) these sort behind `exhausted`.
    const ready = [
      await enqueue(client, "t1", "fixture", { docId: "doc:ready-0" }, "hol-ready-key-0"),
      await enqueue(client, "t1", "fixture", { docId: "doc:ready-1" }, "hol-ready-key-1"),
      await enqueue(client, "t1", "fixture", { docId: "doc:ready-2" }, "hol-ready-key-2"),
    ];

    // A batch size that would previously have been entirely swallowed by
    // the one head-of-line exhausted row.
    const claimed = await claim(client, "worker-b", { batchSize: 3 });
    expect(claimed.map((j) => j.id).sort()).toEqual(ready.map((j) => j.id).sort());

    const final = await client.query("SELECT status FROM jobs WHERE id = $1", [exhausted.id]);
    expect(final.rows[0].status).toBe("dead_letter");
  });
});

describe.skipIf(!available)("job queue — retry, dead-letter, replay", () => {
  it("retries through explicit fail() calls until max_attempts, giving exactly maxAttempts real attempts", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:retry" }, "retry-key", {
      maxAttempts: 2,
    });

    const [claim1] = await claim(client, "worker-a");
    if (!claim1) throw new Error("expected a claimed job");
    expect(claim1.attempts).toBe(1);
    const result1 = await fail(client, job.id, "worker-a", claim1.fence_token, "boom 1", {
      random: () => 0.5,
    });
    expect(result1).toEqual({ status: "pending" });
    const afterFail1 = await client.query(
      "SELECT status, attempts, lease_owner, lease_expires_at, run_after > now() AS scheduled_future FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(afterFail1.rows[0].status).toBe("pending");
    expect(afterFail1.rows[0].attempts).toBe(1);
    expect(afterFail1.rows[0].lease_owner).toBeNull();
    expect(afterFail1.rows[0].scheduled_future).toBe(true);

    // run_after is in the future, so a normal claim() won't pick it back
    // up — force it back into the claimable window for the test.
    await client.query("UPDATE jobs SET run_after = now() WHERE id = $1", [job.id]);
    const [claim2] = await claim(client, "worker-a");
    if (!claim2) throw new Error("expected the job to be claimable for its second attempt");
    expect(claim2.attempts).toBe(2); // the second of exactly maxAttempts=2 attempts
    const result2 = await fail(client, job.id, "worker-a", claim2.fence_token, "boom 2", {
      random: () => 0.5,
    });
    expect(result2).toEqual({ status: "dead_letter" });

    const final = await client.query(
      "SELECT status, attempts, lease_owner, lease_expires_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(final.rows[0].status).toBe("dead_letter");
    expect(final.rows[0].attempts).toBe(2);
    expect(final.rows[0].lease_owner).toBeNull();
    expect(final.rows[0].lease_expires_at).toBeNull();
  });

  it("a worker that repeatedly crashes without calling fail() still exhausts attempts and dead-letters", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:crash" }, "crash-key", {
      maxAttempts: 2,
    });

    // Attempt 1: claimed, then the worker "crashes" — never heartbeats,
    // never fails, just goes silent. Force-expire the lease rather than
    // waiting on a real timer for a deterministic test.
    const [attempt1] = await claim(client, "worker-crash-1", { leaseMs: 60_000 });
    if (!attempt1) throw new Error("expected attempt 1 to be claimed");
    expect(attempt1.attempts).toBe(1);
    await client.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [job.id],
    );

    // Attempt 2: reclaimed via expired lease, consumes the second (and
    // final) allowed attempt, then also "crashes".
    const [attempt2] = await claim(client, "worker-crash-2", { leaseMs: 60_000 });
    if (!attempt2) throw new Error("expected attempt 2 to be claimed, not dead-lettered early");
    expect(attempt2.attempts).toBe(2);
    await client.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [job.id],
    );

    // Attempt 3 would exceed maxAttempts=2 — claim() must dead-letter it
    // directly rather than handing out a third attempt nobody authorized.
    const attempt3 = await claim(client, "worker-crash-3", { leaseMs: 60_000 });
    expect(attempt3.some((j) => j.id === job.id)).toBe(false);

    const final = await client.query(
      "SELECT status, attempts, fence_token, lease_owner, lease_expires_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(final.rows[0].status).toBe("dead_letter");
    // attempts must mean attempts actually granted — never 3 for
    // maxAttempts=2, even though claim() was called a third time.
    expect(final.rows[0].attempts).toBe(2);
    // No new claim was granted on the third call, so no new fence_token —
    // it stays at whatever attempt2's real claim left it at.
    expect(final.rows[0].fence_token).toBe(attempt2.fence_token);
    expect(final.rows[0].lease_owner).toBeNull();
    expect(final.rows[0].lease_expires_at).toBeNull();
  });

  it("scrubs a credential out of the persisted error message", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:err" }, "err-key");
    const [claimed] = await claim(client, "worker-a");
    if (!claimed) throw new Error("expected a claimed job");
    await fail(
      client,
      job.id,
      "worker-a",
      claimed.fence_token,
      "fetch failed: postgresql://eil:hunter2@db.corp.internal/eil",
      { random: () => 0.5 },
    );
    const row = await client.query("SELECT last_error FROM jobs WHERE id = $1", [job.id]);
    expect(row.rows[0].last_error).not.toContain("hunter2");
  });

  it("replay moves a dead-lettered job back to pending with a clean attempt count", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:replay" }, "replay-key", {
      maxAttempts: 1,
    });
    const [claimed] = await claim(client, "worker-a");
    if (!claimed) throw new Error("expected a claimed job");
    await fail(client, job.id, "worker-a", claimed.fence_token, "boom", { random: () => 0.5 });
    const dead = await client.query("SELECT status FROM jobs WHERE id = $1", [job.id]);
    expect(dead.rows[0].status).toBe("dead_letter");

    const replayed = await replay(client, job.id);
    expect(replayed).toBe(true);
    const revived = await client.query("SELECT status, attempts FROM jobs WHERE id = $1", [job.id]);
    expect(revived.rows[0].status).toBe("pending");
    expect(revived.rows[0].attempts).toBe(0);
  });

  it("replay on a non-dead-lettered job is a no-op", async () => {
    const job = await enqueue(client, "t1", "fixture", { docId: "doc:notdead" }, "notdead-key");
    expect(await replay(client, job.id)).toBe(false);
  });
});

describe("scrubJobError", () => {
  it("redacts a detected secret and bounds length", () => {
    const withKey = `error talking to AKIAIOSFODNN7EXAMPLE at ${"x".repeat(3000)}`;
    const r = scrubJobError(withKey);
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.length).toBeLessThanOrEqual(2_000);
  });
});

describe.skipIf(!available)("_clearJobTypesForTests", () => {
  it("removes registrations so a cleared type is unrecognized again", async () => {
    registerJobType("throwaway", z.object({}));
    _clearJobTypesForTests();
    await expect(enqueue(client, "t1", "throwaway", {}, "k")).rejects.toThrow(UnknownJobTypeError);
    registerJobType("fixture", FIXTURE_SCHEMA); // restore for any test after this one
  });
});
