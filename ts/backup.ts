/**
 * F6: operational database backup/restore drill.
 *
 * This is a tested runbook/tooling slice for disaster recovery of the
 * OPERATIONAL Postgres catalog (schema + serving data) via `pg_dump`/
 * `pg_restore` — deliberately narrow in scope:
 *
 * - It is NOT a per-tenant export tool. A restored archive contains every
 *   tenant's data; splitting one tenant out is a separate, unbuilt feature.
 * - It is NOT a substitute for your hosting provider's own managed snapshot
 *   policy (RDS automated backups, Neon branching, Supabase PITR, etc).
 *   Those cover storage-layer failure and retention windows this repo-native
 *   drill does not attempt to replace — run both.
 *
 * The `secrets` schema (connector credentials) is excluded from every backup
 * by construction (`pg_dump --exclude-schema=secrets`), not by convention or
 * a documented caveat — `runBackup()` re-verifies the exclusion actually took
 * via `pg_restore --list` before ever publishing the artifact, and
 * `runRestore()` repeats that same check independently before touching any
 * database, so a hand-crafted or foreign archive can't reach a restored
 * database just because it didn't come from this code path.
 *
 * Connection credentials never appear on any child-process command line —
 * `pg_dump`/`pg_restore` read PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from
 * the environment (see `dsnToPgEnv`), so `ps aux` on the host never shows a
 * DSN or password, and no filename or metadata field carries one either.
 *
 * A backup is published as one bundle DIRECTORY (`archive.dump` +
 * `metadata.json` together), not two independently-renamed files: everything
 * is built under a private temporary sibling directory, verified and
 * digested there, and made visible with exactly one `rename()` of that whole
 * directory onto the requested path. POSIX directory rename is a single
 * atomic operation, so no observer can ever see an archive published without
 * its metadata sidecar (or vice versa) — the two-step "rename the archive,
 * then rename the metadata" sequence this replaced could leave exactly that
 * half-published state if the second rename failed. The same rename also
 * refuses to clobber an existing non-empty bundle (POSIX `rename()` onto a
 * non-empty directory fails with ENOTEMPTY), closing the gap where a
 * separate `existsSync()` check followed by a later `rename()` leaves a
 * window for another process to create the target in between.
 *
 * A restore validates that metadata — archive identity via a SHA-256 digest,
 * declared format/exclusions, pg_dump/pg_restore major-version compatibility,
 * and a non-secret row-count manifest of the source's own catalog tables —
 * before ever creating a database, and drops whatever it created if anything
 * after that point fails, including a manifest mismatch (a truncated or
 * otherwise-altered archive that still carries a self-consistent digest must
 * not report a successful restore).
 *
 * The archive and its bound metadata come from ONE point-in-time snapshot,
 * not from pg_dump finishing and then separate connections querying
 * migrations/table counts afterward — a concurrent write landing in that gap
 * would otherwise let the metadata describe a later database state than the
 * archive actually contains. `withSnapshot()` exports a REPEATABLE READ
 * snapshot, keeps that transaction open across the pg_dump child process
 * (which imports the same snapshot via `--snapshot=<id>`), and queries
 * migrations/manifest through that same transaction before releasing it.
 *
 * Backup creation additionally takes an exclusive sibling lock file on
 * `outputPath` before doing anything else, released in a `finally` no matter
 * how the call ends. This is what actually closes the "another process
 * creates something at outputPath in between our checks and our rename"
 * race for COOPERATING callers of this module — the atomic bundle-directory
 * rename alone only refuses a non-empty destination (POSIX `rename()` onto
 * an existing *empty* directory silently succeeds and replaces it), so it is
 * not sufficient on its own. A lock left behind by a process that is
 * positively confirmed gone (`process.kill(pid, 0)` throwing ESRCH
 * specifically — any other outcome, including EPERM, means the process may
 * still be alive and is treated as active) is reclaimed automatically
 * rather than blocking forever.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { type Db, dsn, withDatabase } from "./db.js";
import { redact, scanSecrets } from "./ingest/secrets.js";

const run = promisify(execFile);
const MAX_ERROR_LENGTH = 2_000;
const MAX_BUFFER = 256 * 1024 * 1024;

/** Same secret-detection engine ts/jobqueue.ts and ts/ingest use — a pg_dump/
 *  pg_restore stderr line can echo upstream text we don't fully control. */
function scrubBackupError(text: string): string {
  return redact(text, scanSecrets(text)).slice(0, MAX_ERROR_LENGTH);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pgErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? ((err as { code?: unknown }).code as string | undefined)
    : undefined;
}

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url).pathname;
const EIL_VERSION: string = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")).version;

const EXCLUDED_SCHEMA = "secrets";
const ARCHIVE_FILENAME = "archive.dump";
const METADATA_FILENAME = "metadata.json";
const UNDEFINED_TABLE = "42P01";

/**
 * Parses connection parameters out of a postgresql:// DSN into the libpq
 * environment variables pg_dump/pg_restore read on their own — the ONLY
 * mechanism used to hand them credentials. Passing `--dbname=<uri-with-
 * password>` on argv instead would put the password in `ps aux` output for
 * the lifetime of the child process, which is exactly the leak this exists
 * to avoid.
 */
function dsnToPgEnv(dsnStr: string): Record<string, string> {
  if (dsnStr.startsWith("pglite://")) {
    throw new Error("backup/restore requires real Postgres — EIL_DATABASE_URL is pglite://");
  }
  const url = new URL(dsnStr);
  const env: Record<string, string> = {};
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, "");
  if (database) env.PGDATABASE = database;
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function directConnect(baseDsn: string, database: string): Promise<Db> {
  const client = new pg.Client({ connectionString: withDatabase(baseDsn, database) });
  await client.connect();
  return client;
}

async function dropDatabase(baseDsn: string, name: string): Promise<void> {
  const admin = await directConnect(baseDsn, "postgres");
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Rows actually present in the SOURCE database's own schema_migrations —
 *  never `migrationFiles()` (files on disk in this checkout), which records
 *  what could theoretically be applied, not what was. A catalog that is
 *  behind the checkout must be reported as behind, not as current.
 *
 *  Only `undefined_table` (42P01) means "zero applied" — the table genuinely
 *  doesn't exist yet. Every other failure (permission denial, connection
 *  loss, a malformed schema, a timeout) is a real problem and must propagate,
 *  not be recorded as a legitimately empty migration catalog. Takes an
 *  already-connected client (the snapshot-holding one — see `withSnapshot`)
 *  rather than opening its own, so this reads the exact same point-in-time
 *  state pg_dump used. */
async function queryAppliedMigrationsViaClient(client: Db): Promise<string[]> {
  try {
    const res = await client.query("SELECT name FROM schema_migrations ORDER BY applied_at, name");
    return res.rows.map((r: { name: string }) => r.name);
  } catch (err) {
    if (pgErrorCode(err) === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/** Catalog tables the source manifest records row counts for — the drill's
 *  actual "did the corpus come back" ground truth, spanning serving data
 *  across the catalog, not just documents. A table is only recorded if it
 *  exists in THIS source (older schemas may lack chunk_vectors, etc); any
 *  other query failure (permission, connection) propagates rather than
 *  being treated as "table doesn't exist." Takes an already-connected
 *  client for the same snapshot-consistency reason as above. */
const MANIFEST_TABLES = ["documents", "chunks", "links", "sync_cursors", "jobs", "chunk_vectors"];

async function buildSourceManifestViaClient(client: Db): Promise<Record<string, number>> {
  const manifest: Record<string, number> = {};
  for (const table of MANIFEST_TABLES) {
    try {
      const res = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`);
      manifest[table] = res.rows[0].n;
    } catch (err) {
      if (pgErrorCode(err) === UNDEFINED_TABLE) continue;
      throw err;
    }
  }
  return manifest;
}

/**
 * Exports one REPEATABLE READ snapshot and keeps it open for the lifetime of
 * `fn`, so pg_dump (via `--snapshot=<id>`) and the migrations/manifest
 * queries all observe EXACTLY the same point-in-time database state — see
 * the module doc comment for why running them as separate connections after
 * pg_dump finishes is unsafe under concurrent writes.
 */
async function withSnapshot<T>(
  sourceDsn: string,
  fn: (snapshotClient: Db, snapshotId: string) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: sourceDsn });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const res = await client.query("SELECT pg_export_snapshot() AS id");
    const snapshotId: string = res.rows[0].id;
    return await fn(client, snapshotId);
  } finally {
    await client.query("COMMIT").catch(() => {});
    await client.end();
  }
}

const LOCK_ACQUIRE_MAX_ATTEMPTS = 10;

/**
 * Exclusive sibling lock at `<outputPath>.lock` used to serialize
 * cooperating `runBackup()` calls targeting the same path (see module doc
 * comment). Two properties matter for correctness under REAL concurrency
 * between independent processes, not just a single contender:
 *
 * - The lock file is never observable with partial content. A naive
 *   `open(..., "wx")` then `write()` creates an EMPTY file before any
 *   content is written — a contender hitting EEXIST in that window could
 *   read "" , parse "no owner", and unlink a lock that is actually live.
 *   This is closed by writing the full token to a private per-attempt temp
 *   file first, then publishing it via `link()` (exclusive — EEXIST if the
 *   target exists): the lock path never exists with anything but fully-
 *   formed content, because the underlying inode's content is complete
 *   before the `link()` that makes it visible at `lockPath` ever happens.
 * - Reclaiming a lock left by a dead process is atomic against the EXACT
 *   file observed, via `rename()` to a unique quarantine path rather than
 *   an unconditional `rm()`. Two reclaimers can both decide the same dead
 *   lock is stale; only one's `rename()` can capture it (the loser gets
 *   ENOENT and retries). The winner then verifies the quarantined content
 *   still matches what it originally read — if it doesn't (a legitimate
 *   fresh owner published in the gap between the read and the rename), the
 *   quarantined file is restored via `link()` rather than discarded, so a
 *   losing reclaimer can never destroy a winner's live lock.
 *
 * Ambiguous or unparseable lock content (which can no longer arise from
 * THIS code's own writes, but is treated defensively regardless) is always
 * read as POSSIBLY ACTIVE, never as stale — reclaiming only proceeds once a
 * PID has been positively parsed AND positively confirmed dead via
 * `process.kill(pid, 0)`. Returns a release function that removes the lock
 * only if it still holds this exact call's token (never a lock some other
 * process has since claimed).
 */
export function acquireBackupLock(outputPath: string): () => void {
  const lockPath = `${outputPath}.lock`;

  const publish = (token: string): void => {
    const tempPath = `${lockPath}.claim-${token}`;
    writeFileSync(tempPath, token, "utf-8");
    try {
      linkSync(tempPath, lockPath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  };

  for (let attempt = 0; attempt < LOCK_ACQUIRE_MAX_ATTEMPTS; attempt++) {
    const token = `${process.pid}-${randomUUID()}`;
    try {
      publish(token);
      return () => {
        try {
          if (readFileSync(lockPath, "utf-8") === token) rmSync(lockPath, { force: true });
        } catch {}
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let existingContent: string;
    try {
      existingContent = readFileSync(lockPath, "utf-8");
    } catch {
      continue; // vanished between our failed link and this read — retry
    }
    const holderMatch = existingContent.match(/^(\d+)-/);
    const holder = holderMatch ? Number(holderMatch[1]) : null;
    // Unparseable content, and any liveness result other than a positively
    // confirmed ESRCH, defaults to "assume active." process.kill(pid, 0)
    // throwing does NOT always mean dead — EPERM means the kernel found a
    // live process we simply lack permission to signal; treating that (or
    // any other unexpected errno) as dead would let two backups reclaim and
    // run against the same path concurrently.
    let holderAlive = true;
    if (holder !== null) {
      try {
        process.kill(holder, 0);
        holderAlive = true;
      } catch (err) {
        holderAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    if (holderAlive) {
      throw new Error(
        `another backup is already in progress for this path (lock: ${lockPath}) — wait for it to finish, or remove the lock file if that process is confirmed gone`,
      );
    }

    if (_testHooks.afterStaleLockRead) _testHooks.afterStaleLockRead();

    // Reclaim atomically against the EXACT file just observed, so a second
    // reclaimer racing on the same dead lock loses cleanly (ENOENT) rather
    // than deleting whatever the winner subsequently created.
    const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      renameSync(lockPath, quarantinePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // lost the reclaim race — retry
      throw err;
    }
    const quarantinedContent = readFileSync(quarantinePath, "utf-8");
    if (quarantinedContent !== existingContent) {
      // We captured something OTHER than the exact dead lock we inspected —
      // a legitimate fresh owner published in the gap between our read and
      // our rename. Restore it rather than discard it; back off and retry.
      try {
        linkSync(quarantinePath, lockPath);
      } catch (restoreErr) {
        if ((restoreErr as NodeJS.ErrnoException).code !== "EEXIST") throw restoreErr;
        // someone else's fresh lock already occupies the slot — nothing to restore
      } finally {
        rmSync(quarantinePath, { force: true });
      }
      continue;
    }
    rmSync(quarantinePath, { force: true }); // confirmed genuinely stale — discard
  }
  throw new Error(
    `could not acquire backup lock for ${outputPath} after ${LOCK_ACQUIRE_MAX_ATTEMPTS} attempts`,
  );
}

export interface BackupToolCheck {
  ok: boolean;
  pgDump?: { version: string };
  pgRestore?: { version: string };
  errors: string[];
}

async function toolVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await run(bin, ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Validates required binaries are on PATH before any dump/restore is attempted. */
export async function checkBackupTools(): Promise<BackupToolCheck> {
  const [pgDumpVersion, pgRestoreVersion] = await Promise.all([
    toolVersion("pg_dump"),
    toolVersion("pg_restore"),
  ]);
  const errors: string[] = [];
  if (!pgDumpVersion) {
    errors.push("pg_dump not found on PATH — install the postgresql-client package");
  }
  if (!pgRestoreVersion) {
    errors.push("pg_restore not found on PATH — install the postgresql-client package");
  }
  return {
    ok: errors.length === 0,
    ...(pgDumpVersion ? { pgDump: { version: pgDumpVersion } } : {}),
    ...(pgRestoreVersion ? { pgRestore: { version: pgRestoreVersion } } : {}),
    errors,
  };
}

function parseMajorVersion(versionOutput: string): number | null {
  const m = versionOutput.match(/(\d+)(?:\.\d+)?/);
  return m ? Number(m[1]) : null;
}

/** A TOC listing (`pg_restore --list`) never touches a target database — the
 *  right tool to verify an archive is well-formed and secrets-free before
 *  trusting it, on both the write side (after dumping) and the read side
 *  (before restoring, in case the archive came from somewhere else). */
async function verifyArchiveExcludesSecrets(archivePath: string): Promise<void> {
  let toc: string;
  try {
    toc = (await run("pg_restore", ["--list", archivePath])).stdout;
  } catch (err) {
    throw new Error(`archive failed verification: ${scrubBackupError(errorMessage(err))}`);
  }
  if (
    new RegExp(`\\bSCHEMA\\b[^\\n]*\\b${EXCLUDED_SCHEMA}\\b`, "i").test(toc) ||
    toc.includes(`${EXCLUDED_SCHEMA}.`)
  ) {
    throw new Error(`archive unexpectedly references the ${EXCLUDED_SCHEMA} schema`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface BackupMetadata {
  eilVersion: string;
  createdAt: string;
  /** Database name only — never host/user/password. */
  sourceDatabase: string;
  /** Rows read from the SOURCE database's own schema_migrations, not files on disk. */
  appliedMigrations: string[];
  pgDumpVersion: string;
  format: "custom";
  excludedSchemas: string[];
  /** SHA-256 of the archive file's bytes, computed before publication — binds this metadata to that exact archive. */
  archiveSha256: string;
  /** Row counts for MANIFEST_TABLES as they stood in the source at backup
   *  time — the ground truth `runRestore()` compares the restored database
   *  against. A table absent from the source is absent from this map, not
   *  recorded as zero. */
  sourceManifest: Record<string, number>;
}

export interface BackupOptions {
  /** Directory the backup bundle (archive.dump + metadata.json) is published under. */
  outputPath: string;
  /** Defaults to dsn() — the ambient EIL_DATABASE_URL. */
  sourceDsn?: string;
  /** Keep the partial temp directory for inspection if the backup fails. Default: delete it. */
  keepOnError?: boolean;
}

export interface BackupResult {
  /** The published bundle directory. */
  backupPath: string;
  archivePath: string;
  metadataPath: string;
  metadata: BackupMetadata;
}

/** Test-only seams — never used by `eil backup create`/`restore`. Let tests
 *  provoke failure points that are otherwise impractical to trigger for
 *  real (a filesystem write failing at one specific step, a post-restore
 *  verification query throwing) without faking the whole dump/restore
 *  pipeline. Same shape as jobqueue.ts's `_clearJobTypesForTests`. */
export const _testHooks: {
  afterArchiveWritten?: (() => void | Promise<void>) | undefined;
  verifyRestoredDatabase?:
    | ((
        baseDsn: string,
        targetDatabase: string,
        sourceManifest: Record<string, number>,
      ) => Promise<RestoreVerification>)
    | undefined;
  /** Fires synchronously, once per acquireBackupLock() attempt, right after
   *  a dead lock's content has been read and positively confirmed stale but
   *  before the rename-to-quarantine reclaim step — lets a test simulate a
   *  concurrent winner publishing a fresh live lock in that exact window. */
  afterStaleLockRead?: (() => void) | undefined;
} = {};

/**
 * Dumps the operational catalog to a portable custom-format archive
 * (`-Fc`), excluding the `secrets` schema and any owner/ACL coupling to
 * this cluster's specific roles (`--no-owner --no-privileges`) — a dump
 * meant to move from a local/dev cluster to a hosted one must not carry
 * role dependencies the target cluster doesn't have.
 *
 * Guarded by an exclusive lock on `outputPath` for the whole call (see
 * `acquireBackupLock`), so a second concurrent call targeting the same path
 * fails immediately instead of racing. The archive and its bound metadata
 * (applied migrations, source manifest) come from one exported snapshot
 * (`withSnapshot`), not from separate connections at different times.
 * Publication is one atomic bundle-directory rename (see module doc
 * comment). A failure at any point before that rename leaves nothing at
 * outputPath — never a partial or unverified file masquerading as a real
 * backup, and never an archive published without its metadata sidecar.
 */
export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const sourceDsn = opts.sourceDsn ?? dsn();
  const env = dsnToPgEnv(sourceDsn);

  const releaseLock = acquireBackupLock(opts.outputPath);
  try {
    if (existsSync(opts.outputPath)) {
      throw new Error(`refusing to overwrite an existing backup artifact: ${opts.outputPath}`);
    }

    const check = await checkBackupTools();
    if (!check.ok) throw new Error(`backup preflight failed: ${check.errors.join("; ")}`);

    const tempDir = `${opts.outputPath}.tmp-${process.pid}-${Date.now()}`;
    const cleanupTemp = () => rmSync(tempDir, { recursive: true, force: true });

    try {
      mkdirSync(tempDir, { recursive: false });
      const tempArchivePath = join(tempDir, ARCHIVE_FILENAME);
      const tempMetadataPath = join(tempDir, METADATA_FILENAME);

      const { appliedMigrations, sourceManifest } = await withSnapshot(
        sourceDsn,
        async (snapshotClient, snapshotId) => {
          await run(
            "pg_dump",
            [
              "--format=custom",
              `--exclude-schema=${EXCLUDED_SCHEMA}`,
              "--no-owner",
              "--no-privileges",
              `--snapshot=${snapshotId}`,
              `--file=${tempArchivePath}`,
            ],
            { env: { ...process.env, ...env }, maxBuffer: MAX_BUFFER },
          );
          await verifyArchiveExcludesSecrets(tempArchivePath);
          if (_testHooks.afterArchiveWritten) await _testHooks.afterArchiveWritten();

          return {
            appliedMigrations: await queryAppliedMigrationsViaClient(snapshotClient),
            sourceManifest: await buildSourceManifestViaClient(snapshotClient),
          };
        },
      );

      const metadata: BackupMetadata = {
        eilVersion: EIL_VERSION,
        createdAt: new Date().toISOString(),
        sourceDatabase: env.PGDATABASE ?? "(unknown)",
        appliedMigrations,
        pgDumpVersion: check.pgDump?.version ?? "(unknown)",
        format: "custom",
        excludedSchemas: [EXCLUDED_SCHEMA],
        archiveSha256: sha256File(tempArchivePath),
        sourceManifest,
      };
      writeFileSync(tempMetadataPath, JSON.stringify(metadata, null, 2), "utf-8");

      // Publication boundary: ONE rename of the whole bundle directory.
      // POSIX rename() of a directory is atomic, so archive+metadata become
      // visible together or not at all. It refuses a non-empty destination
      // (ENOTEMPTY) as defense in depth, but the actual no-clobber
      // guarantee for cooperating callers is the lock acquired above — see
      // the module doc comment.
      renameSync(tempDir, opts.outputPath);

      return {
        backupPath: opts.outputPath,
        archivePath: join(opts.outputPath, ARCHIVE_FILENAME),
        metadataPath: join(opts.outputPath, METADATA_FILENAME),
        metadata,
      };
    } catch (err) {
      if (!opts.keepOnError) cleanupTemp();
      throw new Error(`backup failed: ${scrubBackupError(errorMessage(err))}`);
    }
  } finally {
    releaseLock();
  }
}

const RESERVED_RESTORE_TARGETS = new Set(["postgres", "template0", "template1"]);
/** Conservative identifier shape — also what CREATE DATABASE accepts unquoted-safely. */
const SAFE_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function requireSafeRestoreTarget(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("restore target database name must be a non-empty string");
  }
  if (RESERVED_RESTORE_TARGETS.has(name)) {
    throw new Error(`refusing to restore into a reserved system database: ${name}`);
  }
  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new Error(
      `unsafe restore target database name: ${name} (must match ${SAFE_DATABASE_NAME})`,
    );
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Loads and shape-validates the metadata sidecar — required before any
 *  database is created. Missing, unparseable, or structurally wrong
 *  metadata means the archive is unverifiable and is refused outright. */
function loadAndValidateMetadata(backupPath: string): BackupMetadata {
  const metadataPath = join(backupPath, METADATA_FILENAME);
  if (!existsSync(metadataPath)) {
    throw new Error(
      `metadata sidecar not found: ${metadataPath} — refusing to restore an unverifiable archive`,
    );
  }
  let metadata: BackupMetadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  } catch {
    throw new Error(`metadata sidecar is not valid JSON: ${metadataPath}`);
  }
  if (metadata.format !== "custom") {
    throw new Error(`unsupported archive format declared in metadata: ${metadata.format}`);
  }
  if (
    !Array.isArray(metadata.excludedSchemas) ||
    !metadata.excludedSchemas.includes(EXCLUDED_SCHEMA)
  ) {
    throw new Error(
      `metadata does not declare the ${EXCLUDED_SCHEMA} schema as excluded — refusing to trust this archive`,
    );
  }
  if (typeof metadata.archiveSha256 !== "string" || !SHA256_HEX.test(metadata.archiveSha256)) {
    throw new Error("metadata is missing a valid archive digest");
  }
  if (typeof metadata.eilVersion !== "string" || metadata.eilVersion.length === 0) {
    throw new Error("metadata is missing an EIL version");
  }
  if (
    typeof metadata.sourceManifest !== "object" ||
    metadata.sourceManifest === null ||
    Array.isArray(metadata.sourceManifest)
  ) {
    throw new Error("metadata is missing a source manifest — cannot verify the restore drill");
  }
  // Quoting already prevents SQL injection when these keys are later used to
  // build identifiers, but a malformed sidecar (unknown table, negative or
  // non-integer count) should still be refused outright rather than fed
  // into the restore comparison as-is.
  for (const [table, count] of Object.entries(metadata.sourceManifest)) {
    if (!MANIFEST_TABLES.includes(table)) {
      throw new Error(`metadata source manifest references an unknown table: ${table}`);
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error(`metadata source manifest has an invalid row count for ${table}: ${count}`);
    }
  }
  return metadata;
}

function requireArchiveMatchesMetadata(archivePath: string, metadata: BackupMetadata): void {
  const actual = sha256File(archivePath);
  if (actual !== metadata.archiveSha256) {
    throw new Error(
      `archive does not match its metadata digest (expected ${metadata.archiveSha256}, got ${actual}) — tampered or corrupted`,
    );
  }
}

/** Postgres client tools support restoring from an OLDER server/dump
 *  generation but not reliably a NEWER one — refuse the mismatch rather
 *  than let pg_restore fail confusingly partway through. Versions that
 *  don't parse are not hard-failed on alone; every other metadata/digest
 *  check still applies. */
function requireCompatibleClientVersion(
  metadata: BackupMetadata,
  localPgRestoreVersion: string,
): void {
  const archiveMajor = parseMajorVersion(metadata.pgDumpVersion);
  const localMajor = parseMajorVersion(localPgRestoreVersion);
  if (archiveMajor === null || localMajor === null) return;
  if (archiveMajor > localMajor) {
    throw new Error(
      `archive was produced by pg_dump ${metadata.pgDumpVersion}, but local pg_restore is ` +
        `${localPgRestoreVersion} — a client cannot reliably restore an archive from a newer major version`,
    );
  }
}

export interface RestoreOptions {
  /** The bundle directory produced by runBackup(). */
  backupPath: string;
  targetDatabase: string;
  /** Defaults to dsn() — the ambient EIL_DATABASE_URL's cluster (host/user), database swapped. */
  adminDsn?: string;
}

export interface RestoreVerification {
  secretsSchemaPresent: boolean;
  tableCounts: Record<string, number>;
}

export interface RestoreResult {
  targetDatabase: string;
  verification: RestoreVerification;
}

/** Compares the restored database against the manifest recorded in metadata
 *  at backup time — the drill's actual "did the corpus come back" check. A
 *  table the manifest expects that is missing or has a different row count
 *  after restore is a hard failure, not a silently-skipped table: an
 *  operator restoring a real backup has no other way to know the corpus
 *  actually came back, and a truncated-but-structurally-valid archive with
 *  a self-consistent digest must not be able to report success here. */
async function verifyRestoredDatabase(
  baseDsn: string,
  targetDatabase: string,
  sourceManifest: Record<string, number>,
): Promise<RestoreVerification> {
  const restored = await directConnect(baseDsn, targetDatabase);
  try {
    const secretsCheck = await restored.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [
      EXCLUDED_SCHEMA,
    ]);
    const tableCounts: Record<string, number> = {};
    const mismatches: string[] = [];
    for (const [table, expected] of Object.entries(sourceManifest)) {
      let actual: number;
      try {
        const res = await restored.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`);
        actual = res.rows[0].n;
      } catch (err) {
        if (pgErrorCode(err) === UNDEFINED_TABLE) {
          mismatches.push(`${table}: expected ${expected} row(s), table is missing after restore`);
          continue;
        }
        throw err;
      }
      tableCounts[table] = actual;
      if (actual !== expected) {
        mismatches.push(`${table}: expected ${expected} row(s), restored ${actual}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(`restored data does not match the source manifest: ${mismatches.join("; ")}`);
    }
    return { secretsSchemaPresent: secretsCheck.rows.length > 0, tableCounts };
  } finally {
    await restored.end();
  }
}

/**
 * Restores an archive into a NEWLY CREATED database — never an existing
 * one, and never a reserved system database. Before any database is
 * created, the metadata sidecar is loaded and validated, the archive's
 * digest is checked against it, and pg_dump/pg_restore major-version
 * compatibility is checked — an unverifiable, tampered, or foreign-major-
 * version archive never reaches CREATE DATABASE at all.
 *
 * Everything from CREATE DATABASE onward runs under one failure boundary:
 * ANY rejection in that region — pg_restore itself, the post-restore
 * connection, the verification queries, a source-manifest mismatch, or a
 * positive secrets-schema finding — drops the just-created database before
 * runRestore() rejects. A resolved promise is therefore the only signal
 * that a complete, verified restore exists; a rejected one guarantees the
 * target database does not exist (cleanup failure is reported, appended to
 * the original error, never silently swallowed).
 */
export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  requireSafeRestoreTarget(opts.targetDatabase);

  const baseDsn = opts.adminDsn ?? dsn();
  if (baseDsn.startsWith("pglite://")) {
    throw new Error("restore requires real Postgres — EIL_DATABASE_URL is pglite://");
  }
  if (!existsSync(opts.backupPath)) {
    throw new Error(`backup not found: ${opts.backupPath}`);
  }

  const check = await checkBackupTools();
  if (!check.ok) throw new Error(`restore preflight failed: ${check.errors.join("; ")}`);

  const archivePath = join(opts.backupPath, ARCHIVE_FILENAME);
  const metadata = loadAndValidateMetadata(opts.backupPath);
  requireArchiveMatchesMetadata(archivePath, metadata);
  requireCompatibleClientVersion(metadata, check.pgRestore?.version ?? "");
  await verifyArchiveExcludesSecrets(archivePath);

  const admin = await directConnect(baseDsn, "postgres");
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      opts.targetDatabase,
    ]);
    if (exists.rows.length > 0) {
      throw new Error(`refusing to overwrite an existing database: ${opts.targetDatabase}`);
    }
    await admin.query(`CREATE DATABASE ${quoteIdent(opts.targetDatabase)}`);
  } finally {
    await admin.end();
  }

  try {
    const targetEnv = dsnToPgEnv(withDatabase(baseDsn, opts.targetDatabase));
    await run(
      "pg_restore",
      [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        `--dbname=${opts.targetDatabase}`,
        archivePath,
      ],
      { env: { ...process.env, ...targetEnv }, maxBuffer: MAX_BUFFER },
    );

    const verify = _testHooks.verifyRestoredDatabase ?? verifyRestoredDatabase;
    const verification = await verify(baseDsn, opts.targetDatabase, metadata.sourceManifest);
    if (verification.secretsSchemaPresent) {
      throw new Error(`restored database unexpectedly contains the ${EXCLUDED_SCHEMA} schema`);
    }
    return { targetDatabase: opts.targetDatabase, verification };
  } catch (err) {
    try {
      await dropDatabase(baseDsn, opts.targetDatabase);
    } catch (cleanupErr) {
      throw new Error(
        `${scrubBackupError(errorMessage(err))} (additionally, cleanup failed — database ` +
          `${opts.targetDatabase} may still exist: ${scrubBackupError(errorMessage(cleanupErr))})`,
      );
    }
    throw new Error(`restore failed: ${scrubBackupError(errorMessage(err))}`);
  }
}
