/**
 * Postgres access + migration runner. 12-factor: EIL_DATABASE_URL decides
 * where Postgres lives (laptop brew service today, kube operator after
 * promotion).
 */

import { readFileSync, readdirSync } from "node:fs";
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
 * Zero-install backend: EIL_DATABASE_URL=pglite://<data-dir> runs real
 * Postgres (WASM, in-process) from node_modules — no server, no admin
 * rights. Single process at a time (the data dir is exclusively locked),
 * which matches local single-user mode; kube promotion still targets real
 * Postgres via a normal DSN.
 */
async function connectPglite(url: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = url.slice("pglite://".length) || ".eil-pglite";
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
    end: () => pgl.close(),
  };
}

/** Swap the database in a DSN. node-postgres IGNORES a `database` config field
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
