/**
 * F6 backup/restore drill.
 *
 * Two independent gates, both required for the real drill: real Postgres
 * reachable (same reasoning as ts/tests/jobqueue.test.ts — pg_dump/
 * pg_restore act on a server catalog, not PGlite), AND pg_dump/pg_restore
 * actually present on PATH. Availability is resolved entirely in top-level
 * module code before any describe() registers, for the same
 * describe.skipIf(!available) timing reason established elsewhere in this
 * suite.
 *
 * Postgres being genuinely unreachable is the ONLY truthful reason to skip
 * — a defect in this file's own setup/seed code must fail loudly instead.
 * The initial connectivity probe is the only step wrapped in a swallowing
 * try/catch; everything after it (CREATE DATABASE, migrate, seed) runs
 * unguarded into `bootstrapError`, and a dedicated "bootstrap succeeded"
 * test below re-throws that error when Postgres WAS reachable, so a real
 * bug surfaces as a failing test rather than a silent skip. Every acquired
 * resource (client connection, each created database) is tracked in its
 * own flag so afterAll's cleanup is unconditional and attempts every step
 * regardless of which one failed.
 *
 * A handful of tests that need neither the DB nor the tools (option
 * validation, the pglite guard, checkBackupTools()'s own PATH probe) run
 * ungated so they still execute in an environment missing either.
 */
import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type BackupResult,
  _testHooks,
  acquireBackupLock,
  checkBackupTools,
  runBackup,
  runRestore,
} from "../backup.js";
import { type Db, connect, migrate, migrationFiles, withDatabase } from "../db.js";

const run = promisify(execFile);

async function admin(sqlText: string): Promise<void> {
  const a = await connect("postgres");
  try {
    await a.query(sqlText);
  } finally {
    await a.end();
  }
}

async function expectDatabaseAbsent(name: string): Promise<void> {
  const a = await connect("postgres");
  try {
    const res = await a.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    expect(res.rows.length).toBe(0);
  } finally {
    await a.end();
  }
}

const baseDsn = process.env.EIL_DATABASE_URL ?? "postgresql:///eil";
const SOURCE_DB = "eil_ts_backup_src";
const EXISTING_DB = "eil_ts_backup_existing";

let postgresReachable = true;
try {
  const probe = await connect("postgres");
  await probe.end();
} catch {
  postgresReachable = false;
}

let client: Db | undefined;
let sourceDbCreated = false;
let existingDbCreated = false;
let toolsAvailable = false;
let bootstrapError: unknown = null;

if (postgresReachable) {
  try {
    await admin(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
    await admin(`DROP DATABASE IF EXISTS ${EXISTING_DB} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${SOURCE_DB}`);
    sourceDbCreated = true;
    await admin(`CREATE DATABASE ${EXISTING_DB}`);
    existingDbCreated = true;

    client = await connect(SOURCE_DB);
    const dbCheck = await client.query("SELECT current_database() AS db");
    if (dbCheck.rows[0].db !== SOURCE_DB) throw new Error(`wrong database: ${dbCheck.rows[0].db}`);
    await migrate(client); // populates schema_migrations, not just the raw schema

    // Representative tenant data across every table F6's acceptance list
    // names explicitly, not just documents.
    await client.query(
      "INSERT INTO documents (id, tenant, source, title, content_hash, body) VALUES ($1, $2, $3, $4, $5, $6)",
      ["confluence:page:1", "t1", "confluence", "Runbook", "hash1", "body text"],
    );
    await client.query(
      "INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash) VALUES ($1, $2, $3, $4, $5, $6)",
      ["t1", "confluence:page:1", 0, "", "chunk text", "chash1"],
    );
    await client.query(
      "INSERT INTO chunk_vectors (tenant, doc_id, seq, ord, embedding, embed_model) VALUES ($1, $2, $3, $4, $5, $6)",
      ["t1", "confluence:page:1", 0, 0, [0.1, 0.2, 0.3], "test-model"],
    );
    await client.query("INSERT INTO links (tenant, src_id, dst_id, rel) VALUES ($1, $2, $3, $4)", [
      "t1",
      "confluence:page:1",
      "confluence:page:2",
      "references",
    ]);
    await client.query("INSERT INTO sync_cursors (tenant, source, cursor) VALUES ($1, $2, $3)", [
      "t1",
      "confluence",
      "2026-01-01T00:00:00Z",
    ]);
    await client.query(
      "INSERT INTO jobs (tenant, job_type, payload, idempotency_key) VALUES ($1, $2, $3, $4)",
      ["t1", "ingest:obsidian", JSON.stringify({ vault: "/tmp/x" }), "backup-test-job"],
    );
    // The sentinel: this row, and the whole schema it lives in, must never
    // reach a backup archive or survive a restore.
    await client.query(
      "INSERT INTO secrets.connector_credentials (tenant, name, ciphertext, nonce, auth_tag, key_version) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        "t1",
        "confluence-token",
        Buffer.from("sentinel-ciphertext"),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        1,
      ],
    );

    toolsAvailable = (await checkBackupTools()).ok;
  } catch (err) {
    bootstrapError = err;
  }
}
const available = postgresReachable && toolsAvailable && !bootstrapError;

afterAll(async () => {
  if (client) await client.end().catch(() => {});
  if (sourceDbCreated)
    await admin(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`).catch(() => {});
  if (existingDbCreated)
    await admin(`DROP DATABASE IF EXISTS ${EXISTING_DB} WITH (FORCE)`).catch(() => {});
});

describe("backup — bootstrap", () => {
  it("succeeded when Postgres was reachable (a setup/seed defect must fail here, not skip silently)", () => {
    if (postgresReachable && bootstrapError) throw bootstrapError;
  });
});

describe("backup — tool availability (no DB required)", () => {
  it("truthfully reports whether pg_dump/pg_restore are on PATH", async () => {
    const check = await checkBackupTools();
    if (check.ok) {
      expect(check.pgDump?.version).toBeTruthy();
      expect(check.pgRestore?.version).toBeTruthy();
      expect(check.errors).toEqual([]);
    } else {
      expect(check.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("backup — input validation (no DB or tools required)", () => {
  it("refuses to back up a pglite:// source before touching pg_dump", async () => {
    await expect(
      runBackup({ outputPath: "/tmp/whatever-bundle", sourceDsn: "pglite://.eil-somewhere" }),
    ).rejects.toThrow(/pglite/);
  });

  it("refuses to restore into a pglite:// cluster before touching pg_restore", async () => {
    await expect(
      runRestore({
        backupPath: "/tmp/whatever-bundle",
        targetDatabase: "x",
        adminDsn: "pglite://.eil-somewhere",
      }),
    ).rejects.toThrow(/pglite/);
  });

  it("rejects reserved or unsafe restore target names before touching any database", async () => {
    for (const bad of [
      "postgres",
      "template0",
      "template1",
      "",
      "has space",
      "has;semicolon",
      "x".repeat(70),
    ]) {
      await expect(
        runRestore({ backupPath: "/nonexistent-bundle", targetDatabase: bad }),
      ).rejects.toThrow();
    }
  });
});

describe("backup — exclusive lock protocol (no DB or tools required)", () => {
  // acquireBackupLock() is pure filesystem + process-liveness logic — it
  // needs neither Postgres nor pg_dump/pg_restore, so every test here runs
  // unconditionally instead of hiding behind the real-Postgres-drill gate.

  it("refuses a second concurrent acquire for the same output path — no timing hack needed, since acquisition is fully synchronous", () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-lock-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    try {
      const release = acquireBackupLock(outputPath);
      expect(() => acquireBackupLock(outputPath)).toThrow(/already in progress/);
      release();
      expect(existsSync(lockPath)).toBe(false); // released after success

      // A fresh acquire succeeds cleanly once the first is released.
      const release2 = acquireBackupLock(outputPath);
      release2();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a lock left behind by a process that is no longer alive, instead of refusing forever", () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-stale-lock-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    // spawnSync blocks until the child has already exited, so its pid is
    // deterministically dead by the time we write it into the lock file —
    // no PID-reuse race to worry about in this narrow window. Content shape
    // (`<pid>-<token>`) matches what acquireBackupLock() itself writes.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(lockPath, `${dead.pid}-legacy-test-token`);
    try {
      const release = acquireBackupLock(outputPath);
      expect(existsSync(lockPath)).toBe(true);
      release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an empty or malformed lock file as possibly active, refusing rather than silently reclaiming it (closes the create-before-write-content race)", () => {
    // This is exactly what a contender could have observed under the old
    // open(path, "wx") + write() sequence, mid-publish, before the fix that
    // writes full content to a private temp file and publishes it via a
    // single atomic link() — the lock path never exists with partial
    // content anymore, but a stray empty file (however it got there) must
    // still never be treated as "no owner, safe to steal."
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-empty-lock-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    writeFileSync(lockPath, "");
    try {
      expect(() => acquireBackupLock(outputPath)).toThrow(/already in progress/);
      expect(existsSync(lockPath)).toBe(true); // never touched, not silently reclaimed
      expect(readFileSync(lockPath, "utf-8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats EPERM from process.kill(pid, 0) as possibly alive, not dead — only ESRCH may authorize stale takeover", () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-eperm-lock-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    const unsignalablePid = 999999;
    writeFileSync(lockPath, `${unsignalablePid}-unsignalable-owner`);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === unsignalablePid) {
        const err: NodeJS.ErrnoException = new Error("Operation not permitted");
        err.code = "EPERM";
        throw err;
      }
      throw new Error(`unexpected pid signalled in test: ${pid}`);
    }) as typeof process.kill);
    try {
      // EPERM means the kernel found a live process this call merely lacks
      // permission to signal — reclaiming it would risk two backups running
      // against the same path concurrently, so this must refuse, not steal.
      expect(() => acquireBackupLock(outputPath)).toThrow(/already in progress/);
      expect(readFileSync(lockPath, "utf-8")).toBe(`${unsignalablePid}-unsignalable-owner`);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores a lock that turns out to be live (not the dead one it inspected) instead of destroying it — the dual-stale-reclaimer race", () => {
    // Seeds a dead-owner lock, then uses the test-only hook that fires
    // right after acquireBackupLock() has read and confirmed it stale (but
    // before it reclaims it) to simulate a concurrent winner publishing a
    // fresh LIVE lock in that exact window — proving the real reclaim code
    // detects the mismatch and restores the winner's lock rather than
    // destroying it (the bug: an unconditional rm() there would delete it).
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-dual-reclaim-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(lockPath, `${dead.pid}-deadtoken`);

    const simulatedLiveToken = `${process.pid}-simulated-concurrent-winner`;
    _testHooks.afterStaleLockRead = () => {
      _testHooks.afterStaleLockRead = undefined; // the race window exists exactly once
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, simulatedLiveToken);
    };
    try {
      expect(() => acquireBackupLock(outputPath)).toThrow(/already in progress/);
      // The critical assertion: the simulated winner's lock survived intact.
      // An implementation using an unconditional rm() during reclaim would
      // have deleted it while losing this race.
      expect(readFileSync(lockPath, "utf-8")).toBe(simulatedLiveToken);
    } finally {
      _testHooks.afterStaleLockRead = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release() only removes the lock if it still holds this exact call's token, never a lock some other process now owns", () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-exact-token-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    try {
      const release = acquireBackupLock(outputPath);
      // Simulate this lock having since been replaced by someone else's —
      // release() must be a no-op here, not delete it just because a lock
      // file happens to exist at this path.
      const otherToken = "999999-someone-elses-token";
      writeFileSync(lockPath, otherToken);
      release();
      expect(readFileSync(lockPath, "utf-8")).toBe(otherToken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives up with a clear error after bounded retries rather than looping forever under sustained contention", () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-bounded-retry-"));
    const outputPath = join(dir, "catalog-backup");
    const lockPath = `${outputPath}.lock`;
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(lockPath, `${dead.pid}-seed`);
    let hookCalls = 0;
    _testHooks.afterStaleLockRead = () => {
      // Every attempt "loses" the reclaim race to a fresh dead-owner lock
      // that never resolves — forces the bounded retry limit to trigger
      // instead of retrying indefinitely.
      hookCalls++;
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, `${dead.pid}-contender-${hookCalls}`);
    };
    try {
      expect(() => acquireBackupLock(outputPath)).toThrow(/could not acquire backup lock/);
      expect(hookCalls).toBeGreaterThan(1); // proves it actually retried, not failed on attempt one
    } finally {
      _testHooks.afterStaleLockRead = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!available)("backup — real-Postgres drill", () => {
  async function freshBackup(destDir: string): Promise<BackupResult> {
    const outputPath = join(destDir, "catalog-backup");
    return runBackup({ outputPath, sourceDsn: withDatabase(baseDsn, SOURCE_DB) });
  }

  it("dump excludes secrets, restore recovers representative data, secrets sentinel does not survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-drill-"));
    const targetDb = "eil_ts_backup_restored";
    try {
      const backupResult = await freshBackup(dir);
      expect(existsSync(backupResult.backupPath)).toBe(true);
      expect(existsSync(backupResult.archivePath)).toBe(true);
      expect(existsSync(backupResult.metadataPath)).toBe(true);
      expect(backupResult.metadata.excludedSchemas).toContain("secrets");
      expect(backupResult.metadata.appliedMigrations.length).toBeGreaterThan(0);
      expect(backupResult.metadata.sourceDatabase).toBe(SOURCE_DB);
      expect(backupResult.metadata.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(backupResult.metadata.sourceManifest.documents).toBe(1);
      expect(backupResult.metadata.sourceManifest.chunks).toBe(1);
      expect(backupResult.metadata.sourceManifest.chunk_vectors).toBe(1);
      expect(backupResult.metadata.sourceManifest.links).toBe(1);
      expect(backupResult.metadata.sourceManifest.sync_cursors).toBe(1);
      expect(backupResult.metadata.sourceManifest.jobs).toBe(1);

      const restoreResult = await runRestore({
        backupPath: backupResult.backupPath,
        targetDatabase: targetDb,
        adminDsn: baseDsn,
      });

      expect(restoreResult.verification.secretsSchemaPresent).toBe(false);
      expect(restoreResult.verification.tableCounts.documents).toBe(1);
      expect(restoreResult.verification.tableCounts.chunks).toBe(1);
      expect(restoreResult.verification.tableCounts.chunk_vectors).toBe(1);
      expect(restoreResult.verification.tableCounts.links).toBe(1);
      expect(restoreResult.verification.tableCounts.sync_cursors).toBe(1);
      expect(restoreResult.verification.tableCounts.jobs).toBe(1);

      // Content, not just counts — and confirm the secrets TABLE itself is
      // unreachable in the restored database, not merely empty.
      const restored = await connect(targetDb);
      try {
        const doc = await restored.query("SELECT title, body FROM documents WHERE id = $1", [
          "confluence:page:1",
        ]);
        expect(doc.rows[0].title).toBe("Runbook");
        expect(doc.rows[0].body).toBe("body text");
        const secretsTable = await restored.query(
          "SELECT to_regclass('secrets.connector_credentials') AS reg",
        );
        expect(secretsTable.rows[0].reg).toBeNull();
      } finally {
        await restored.end();
      }
    } finally {
      await admin(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore into an already-existing database, leaving it untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-existing-"));
    try {
      const { backupPath } = await freshBackup(dir);
      await expect(
        runRestore({ backupPath, targetDatabase: EXISTING_DB, adminDsn: baseDsn }),
      ).rejects.toThrow(/existing database/);

      const stillThere = await connect(EXISTING_DB);
      try {
        const res = await stillThere.query("SELECT to_regclass('documents') AS reg");
        expect(res.rows[0].reg).toBeNull(); // never touched, never migrated, never restored into
      } finally {
        await stillThere.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore an archive that does contain the secrets schema — verification is not just trusting the exclude flag", async () => {
    // Bypasses runBackup()'s own --exclude-schema and bundle-publication
    // entirely, hand-building a bundle directory to prove the defense-in-
    // depth check in runRestore() (pg_restore --list) catches a leaky or
    // foreign archive on its own. Writes its own matching metadata sidecar
    // (correct digest, empty manifest) so this test isolates the secrets
    // check specifically, not metadata/manifest validation.
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-leaky-"));
    const bundlePath = join(dir, "leaky-backup");
    mkdirSync(bundlePath);
    const archivePath = join(bundlePath, "archive.dump");
    try {
      const url = new URL(withDatabase(baseDsn, SOURCE_DB));
      const env = {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port,
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: SOURCE_DB,
      };
      await run("pg_dump", ["--format=custom", `--file=${archivePath}`], { env });

      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
      writeFileSync(
        join(bundlePath, "metadata.json"),
        JSON.stringify({
          eilVersion: "0.0.0-test",
          createdAt: new Date().toISOString(),
          sourceDatabase: SOURCE_DB,
          appliedMigrations: [],
          pgDumpVersion: (await checkBackupTools()).pgDump?.version ?? "unknown",
          format: "custom",
          excludedSchemas: ["secrets"], // lies — the archive above was never given --exclude-schema
          archiveSha256: digest,
          sourceManifest: {},
        }),
      );

      const targetDb = "eil_ts_backup_leaky_target";
      await expect(
        runRestore({ backupPath: bundlePath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/secrets/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the newly created database if post-restore verification itself throws, not just when it finds a problem", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-verify-throws-"));
    const targetDb = "eil_ts_backup_verify_throws";
    try {
      const { backupPath } = await freshBackup(dir);
      _testHooks.verifyRestoredDatabase = async () => {
        throw new Error("simulated verification failure");
      };
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/simulated verification failure/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      _testHooks.verifyRestoredDatabase = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing backup bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-overwrite-"));
    const outputPath = join(dir, "catalog-backup");
    writeFileSync(outputPath, "not a real bundle");
    try {
      await expect(
        runBackup({ outputPath, sourceDsn: withDatabase(baseDsn, SOURCE_DB) }),
      ).rejects.toThrow(/existing backup artifact/);
      expect(readFileSync(outputPath, "utf-8")).toBe("not a real bundle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to clobber a non-empty directory materializing at outputPath mid-publish (defense in depth beyond the lock)", async () => {
    // Simulates a NON-cooperating writer (one that doesn't go through
    // acquireBackupLock at all) dropping a non-empty directory at the same
    // path between runBackup()'s initial existsSync() check and its final
    // rename. The atomic bundle-directory rename refuses this on its own
    // (POSIX rename() onto a non-empty directory fails with ENOTEMPTY) —
    // but this alone is NOT sufficient for the empty-directory case (POSIX
    // rename() onto an EXISTING EMPTY directory silently succeeds), which
    // is exactly why the exclusive lock below is the real guarantee for
    // cooperating callers.
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-nonempty-race-"));
    const outputPath = join(dir, "catalog-backup");
    _testHooks.afterArchiveWritten = () => {
      mkdirSync(outputPath);
      writeFileSync(join(outputPath, "sentinel"), "do not touch");
    };
    try {
      await expect(
        runBackup({ outputPath, sourceDsn: withDatabase(baseDsn, SOURCE_DB) }),
      ).rejects.toThrow();
      expect(readFileSync(join(outputPath, "sentinel"), "utf-8")).toBe("do not touch");
      expect(existsSync(join(outputPath, "archive.dump"))).toBe(false);
    } finally {
      _testHooks.afterArchiveWritten = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds the archive and its metadata to one consistent point-in-time snapshot, not to whatever the database looks like when metadata happens to be queried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-snapshot-"));
    const outputPath = join(dir, "catalog-backup");
    const targetDb = "eil_ts_backup_snapshot_consistency";
    // Fires after pg_dump has already captured its snapshot but before the
    // manifest/migrations are read — a write landing here on a SEPARATE,
    // freshly-committed connection must NOT be visible to either the
    // archive (already dumped) or the manifest (read through the same
    // snapshot transaction pg_dump imported).
    _testHooks.afterArchiveWritten = async () => {
      const writer = await connect(SOURCE_DB);
      try {
        await writer.query(
          "INSERT INTO documents (id, tenant, source, title, content_hash, body) VALUES ($1,$2,$3,$4,$5,$6)",
          ["confluence:page:concurrent", "t1", "confluence", "Concurrent", "hashX", "late text"],
        );
      } finally {
        await writer.end();
      }
    };
    try {
      const result = await runBackup({ outputPath, sourceDsn: withDatabase(baseDsn, SOURCE_DB) });
      expect(result.metadata.sourceManifest.documents).toBe(1); // not 2 — the concurrent row is invisible to this snapshot

      const restoreResult = await runRestore({
        backupPath: result.backupPath,
        targetDatabase: targetDb,
        adminDsn: baseDsn,
      });
      expect(restoreResult.verification.tableCounts.documents).toBe(1);
    } finally {
      _testHooks.afterArchiveWritten = undefined;
      await admin(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`);
      if (client)
        await client.query("DELETE FROM documents WHERE id = $1", ["confluence:page:concurrent"]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no partial bundle or temp directory if publication fails after the archive was dumped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-pubfail-"));
    const outputPath = join(dir, "catalog-backup");
    _testHooks.afterArchiveWritten = () => {
      throw new Error("simulated publication failure");
    };
    try {
      await expect(
        runBackup({ outputPath, sourceDsn: withDatabase(baseDsn, SOURCE_DB) }),
      ).rejects.toThrow(/simulated publication failure/);
      expect(existsSync(outputPath)).toBe(false);
      const leftover = readdirSync(dir).filter((f) => f.startsWith("catalog-backup"));
      expect(leftover).toEqual([]);
    } finally {
      _testHooks.afterArchiveWritten = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates a non-undefined-table failure when reading applied migrations, rather than reporting a zero-migration backup", async () => {
    // ALTER-ing the bookkeeping column produces a different Postgres error
    // (undefined_column, 42703) than the "table genuinely doesn't exist yet"
    // case (undefined_table, 42P01) — only the latter may legitimately mean
    // "zero migrations applied."
    const brokenDb = "eil_ts_backup_broken_migrations";
    await admin(`DROP DATABASE IF EXISTS ${brokenDb} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${brokenDb}`);
    const brokenClient = await connect(brokenDb);
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-broken-migrations-"));
    const outputPath = join(dir, "catalog-backup");
    try {
      await migrate(brokenClient);
      await brokenClient.query("ALTER TABLE schema_migrations RENAME COLUMN name TO renamed_name");
      await expect(
        runBackup({ outputPath, sourceDsn: withDatabase(baseDsn, brokenDb) }),
      ).rejects.toThrow();
      // Must NOT have silently published a backup with an empty migration list.
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      await brokenClient.end();
      await admin(`DROP DATABASE IF EXISTS ${brokenDb} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("metadata reports the source database's actually-applied migrations, not files present in this checkout", async () => {
    const behindDb = "eil_ts_backup_behind";
    await admin(`DROP DATABASE IF EXISTS ${behindDb} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${behindDb}`);
    const behindClient = await connect(behindDb);
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-behind-"));
    try {
      await migrate(behindClient);
      const total = migrationFiles().length;
      // Simulate a catalog behind the checkout WITHOUT actually reverting
      // its schema — deleting the bookkeeping row is enough to prove
      // runBackup() reads schema_migrations, not migrationFiles() on disk.
      await behindClient.query(
        "DELETE FROM schema_migrations WHERE name = (SELECT max(name) FROM schema_migrations)",
      );
      const outputPath = join(dir, "catalog-backup");
      const result = await runBackup({
        outputPath,
        sourceDsn: withDatabase(baseDsn, behindDb),
      });
      expect(result.metadata.appliedMigrations.length).toBe(total - 1);
    } finally {
      await behindClient.end();
      await admin(`DROP DATABASE IF EXISTS ${behindDb} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the metadata sidecar is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-meta-missing-"));
    const targetDb = "eil_ts_backup_meta_missing";
    try {
      const { backupPath, metadataPath } = await freshBackup(dir);
      rmSync(metadataPath);
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/metadata sidecar not found/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the archive bytes don't match the metadata digest (tampered archive)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-tampered-archive-"));
    const targetDb = "eil_ts_backup_tampered_archive";
    try {
      const { backupPath, archivePath } = await freshBackup(dir);
      const buf = readFileSync(archivePath);
      buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff;
      writeFileSync(archivePath, buf);
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/does not match its metadata digest/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the metadata sidecar's digest field was tampered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-tampered-meta-"));
    const targetDb = "eil_ts_backup_tampered_meta";
    try {
      const { backupPath, metadataPath } = await freshBackup(dir);
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
      meta.archiveSha256 = "0".repeat(64);
      writeFileSync(metadataPath, JSON.stringify(meta));
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/does not match its metadata digest/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore an archive whose metadata declares an unsupported format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-bad-format-"));
    const targetDb = "eil_ts_backup_bad_format";
    try {
      const { backupPath, metadataPath } = await freshBackup(dir);
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
      meta.format = "plain";
      writeFileSync(metadataPath, JSON.stringify(meta));
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/unsupported archive format/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore an archive whose metadata declares an incompatible (newer) pg_dump major version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-bad-version-"));
    const targetDb = "eil_ts_backup_bad_version";
    try {
      const { backupPath, metadataPath } = await freshBackup(dir);
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
      meta.pgDumpVersion = "pg_dump (PostgreSQL) 999.0";
      writeFileSync(metadataPath, JSON.stringify(meta));
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/newer major version/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the metadata sidecar is missing a source manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-no-manifest-"));
    const targetDb = "eil_ts_backup_no_manifest";
    try {
      const { backupPath, metadataPath, archivePath } = await freshBackup(dir);
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
      delete meta.sourceManifest;
      writeFileSync(metadataPath, JSON.stringify(meta));
      // Recompute digest is unnecessary — archive bytes are untouched, and
      // this test isolates the manifest-presence check specifically.
      void archivePath;
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/source manifest/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the drill when restored row counts don't match the source manifest recorded at backup time (a truncated or altered archive must not report success)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-manifest-mismatch-"));
    const targetDb = "eil_ts_backup_manifest_mismatch";
    try {
      const { backupPath, metadataPath } = await freshBackup(dir);
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
      meta.sourceManifest.documents = 999; // claim more rows than the archive actually restores
      writeFileSync(metadataPath, JSON.stringify(meta)); // digest untouched — still matches the archive bytes
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/does not match the source manifest/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the metadata sidecar's source manifest references an unknown table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-backup-manifest-unknown-table-"));
    const targetDb = "eil_ts_backup_manifest_unknown_table";
    try {
      const { backupPath, metadataPath } = await freshBackup(dir);
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
      meta.sourceManifest.evil_table = 5;
      writeFileSync(metadataPath, JSON.stringify(meta));
      await expect(
        runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
      ).rejects.toThrow(/unknown table/);
      await expectDatabaseAbsent(targetDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the metadata sidecar's source manifest has a non-integer or negative row count", async () => {
    const targetDb = "eil_ts_backup_manifest_bad_count";
    for (const badCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      const dir = mkdtempSync(join(tmpdir(), "eil-backup-manifest-bad-count-"));
      try {
        const { backupPath, metadataPath } = await freshBackup(dir);
        const meta = JSON.parse(readFileSync(metadataPath, "utf-8"));
        meta.sourceManifest.documents = badCount;
        writeFileSync(metadataPath, JSON.stringify(meta));
        await expect(
          runRestore({ backupPath, targetDatabase: targetDb, adminDsn: baseDsn }),
        ).rejects.toThrow(/invalid row count/);
        await expectDatabaseAbsent(targetDb);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
