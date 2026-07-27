/**
 * Postgres access + migration runner. 12-factor: EIL_DATABASE_URL decides
 * where Postgres lives (laptop brew service today, kube operator after
 * promotion).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname;

export function dsn(): string {
  return process.env.EIL_DATABASE_URL ?? "postgresql:///eil";
}

/** Swap the database in a DSN. node-postgres IGNORES a `database` config field
 * when connectionString is present, so overrides must happen in the URL itself. */
export function withDatabase(dsnStr: string, database: string): string {
  const url = new URL(dsnStr);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function connect(database?: string): Promise<pg.Client> {
  const connectionString = database === undefined ? dsn() : withDatabase(dsn(), database);
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
export async function migrate(client: pg.Client): Promise<string[]> {
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
