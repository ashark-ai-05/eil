/**
 * Postgres access + migration runner. 12-factor: EIL_DATABASE_URL decides
 * where Postgres lives (laptop brew service today, kube operator after
 * promotion).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname;

/**
 * Minimal database contract every module codes against. pg.Client satisfies
 * it structurally; the PGlite adapter implements it for the zero-install
 * path. Only query + end — the whole codebase already uses nothing else.
 */
export interface Db {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
}

export function dsn(): string {
  return process.env.EIL_DATABASE_URL ?? "postgresql:///eil";
}

/**
 * The DSN with any password removed, for printing.
 *
 * Every message that names the database a command is talking to goes through
 * here. A connection string is exactly the kind of thing that ends up in a
 * screenshot, a bug report or a shared terminal.
 */
export function safeDsn(url: string = dsn()): string {
  return url.replace(/(\/\/[^/@]*:)[^@]*@/, "$1***@");
}

/**
 * Migrations that exist on disk but have not been applied to this database.
 *
 * A database with no "schema_migrations" table at all has had none applied —
 * that is an empty catalog, not an error, so it reports every migration as
 * pending rather than throwing.
 */
export async function pendingMigrations(client: Db): Promise<string[]> {
  const all = migrationFiles().map((m) => m.name);
  try {
    const res = await client.query("SELECT name FROM schema_migrations");
    const done = new Set(res.rows.map((r) => r.name as string));
    return all.filter((n) => !done.has(n));
  } catch {
    return all;
  }
}

/**
 * Raised when a command is pointed at a database that cannot answer it.
 *
 * Carries a finished, human-readable message: the CLI prints it verbatim and
 * suppresses the stack, because a driver stack trace for "you are talking to
 * the wrong database" sends people looking for a bug that is not there.
 */
export class CatalogNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogNotReady";
  }
}

/**
 * Refuse to run a read that needs a current schema against one that is behind.
 *
 * The failure this prevents is specific and was hit for real: the demo runner
 * sets EIL_DATABASE_URL itself, so a command typed by hand afterwards falls
 * back to "postgresql:///eil" and lands on whatever stale database happens to
 * be there. The raw error from that ("column c.tenant does not exist") reads
 * like a bug in the command rather than a pointer at the wrong catalog.
 */
/**
 * Demo data directories sitting in the working directory, most recent first.
 *
 * The overwhelmingly common reason to see this error is having just run the
 * demo: it sets EIL_DATABASE_URL for its own child processes, so the next
 * hand-typed command has no idea where that catalog went. If one is lying
 * right here, name it — "set this variable" is a much worse answer than "you
 * probably meant this one, here is the line".
 */
function demoCatalogsHere(): string[] {
  const candidates = [".eil-demo", ".eil-pglite"];
  return candidates.filter((d) => {
    try {
      return readdirSync(d).length > 0;
    } catch {
      return false;
    }
  });
}

export async function assertCatalogReady(client: Db): Promise<void> {
  const pending = await pendingMigrations(client);
  if (pending.length === 0) return;
  const total = migrationFiles().length;
  const explicit = !!process.env.EIL_DATABASE_URL;
  const nearby = explicit ? [] : demoCatalogsHere();

  const lines = [
    pending.length === total
      ? `No catalog here — none of the ${total} migrations have been applied.`
      : `This catalog is ${pending.length} migration(s) behind (first missing: ${pending[0]}).`,
    "",
    `  database   ${safeDsn()}`,
    explicit
      ? "             (from EIL_DATABASE_URL)"
      : "             (the default — EIL_DATABASE_URL is not set in this shell)",
    "",
  ];

  if (nearby.length > 0) {
    lines.push(
      `  There is a catalog in this directory. You probably want:`,
      "",
      `      export EIL_DATABASE_URL=pglite://${nearby[0]}`,
      "",
      "  Then run the command again.",
    );
  } else if (explicit) {
    lines.push("  Bring it up to date:   eil db migrate");
  } else {
    lines.push(
      "  If you meant the demo:  node demo/eil.mjs   (then export the line it prints)",
      "  Otherwise migrate it:   eil db migrate",
    );
  }
  throw new CatalogNotReady(lines.join("\n"));
}

/**
 * Zero-install backend: EIL_DATABASE_URL=pglite://<data-dir> runs real
 * Postgres (WASM, in-process) from node_modules — no server, no admin
 * rights. PGlite itself enforces NO lock on its data dir — two processes can
 * open it concurrently and silently interleave (verified experimentally) —
 * so EIL adds a pidfile lock: the second process gets a clear error instead
 * of silent concurrent access. Reentrant within one process; stale locks
 * (dead pid) are reclaimed. Kube promotion targets server Postgres via DSN.
 */
function acquirePgliteLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    let holder = 0;
    try {
      holder = Number(readFileSync(lockPath, "utf-8")) || 0;
    } catch {}
    if (holder === process.pid) return; // reentrant within this process
    let alive = false;
    if (holder > 0) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {}
    }
    if (alive) {
      throw new Error(
        `pglite data dir is in use by pid ${holder} (${lockPath}). PGlite supports one process at a time — stop the other process, or switch to a server tier (see README concurrency decision rule).`,
      );
    }
    rmSync(lockPath, { force: true }); // stale lock from a dead process
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  }
  process.once("exit", () => {
    try {
      if (Number(readFileSync(lockPath, "utf-8")) === process.pid)
        rmSync(lockPath, { force: true });
    } catch {}
  });
}

async function connectPglite(url: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = url.slice("pglite://".length) || ".eil-pglite";
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, ".eil.lock");
  acquirePgliteLock(lockPath);
  const pgl = await PGlite.create(dataDir);
  return {
    query: async (text: string, params?: any[]) => {
      if (params && params.length > 0) return await pgl.query(text, params);
      // no-param path via exec: prepared statements reject multi-statement
      // SQL (migration files); exec runs them and returns per-statement
      // results — surface the last one's rows.
      const results = await pgl.exec(text);
      return results[results.length - 1] ?? { rows: [] };
    },
    end: async () => {
      await pgl.close();
      try {
        if (Number(readFileSync(lockPath, "utf-8")) === process.pid) {
          rmSync(lockPath, { force: true });
        }
      } catch {}
    },
  };
}

/** Swap the database in a DSN. node-postgres IGNORES a "database" config field
 * when connectionString is present, so overrides must happen in the URL itself.
 * PGlite has one database per data dir — overrides are meaningless there. */
export function withDatabase(dsnStr: string, database: string): string {
  if (dsnStr.startsWith("pglite://")) {
    throw new Error("pglite backend has a single database per data dir");
  }
  const url = new URL(dsnStr);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function connect(database?: string): Promise<Db> {
  const base = dsn();
  if (base.startsWith("pglite://")) {
    if (database !== undefined) return connectPglite(withDatabase(base, database)); // throws
    return connectPglite(base);
  }
  const connectionString = database === undefined ? base : withDatabase(base, database);
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export function migrationFiles(dir: string = MIGRATIONS_DIR): Array<{ name: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf-8") }));
}

/** Apply pending migrations/*.sql in filename order. Returns those applied. */
export async function migrate(client: Db): Promise<string[]> {
  const applied: string[] = [];
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set(
    (await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string),
  );
  for (const { name, sql } of migrationFiles()) {
    if (done.has(name)) continue;
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    applied.push(name);
  }
  return applied;
}
