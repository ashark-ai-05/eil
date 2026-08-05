import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresSecretStore,
  encryptionKey,
  secretFreeDumpArgs,
} from "../connectors/secret-store.js";
import { type Db, connect, migrate, provisionRuntimeRoles, runtimeDsns } from "../db.js";

const dir = mkdtempSync(join(tmpdir(), "eil-secret-store-"));
let db: Db;
const key = randomBytes(32);

beforeAll(async () => {
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  db = await connect();
  await provisionRuntimeRoles(db);
  await migrate(db);
});

afterAll(async () => {
  await db.end();
  delete process.env.EIL_DATABASE_URL;
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime database and secret-store policy", () => {
  it("requires distinct server DSNs for API and worker", () => {
    process.env.EIL_DATABASE_API_URL = "postgresql://same@example/eil";
    process.env.EIL_DATABASE_WORKER_URL = "postgresql://same@example/eil";
    expect(runtimeDsns).toThrow(/different credentials/);
    process.env.EIL_DATABASE_WORKER_URL = "pglite://worker";
    expect(runtimeDsns).toThrow(/server PostgreSQL/);
    delete process.env.EIL_DATABASE_API_URL;
    delete process.env.EIL_DATABASE_WORKER_URL;
  });

  it("validates the external KEK shape", () => {
    expect(() => encryptionKey()).toThrow(/EIL_SECRETS_KEK/);
    expect(() => encryptionKey(Buffer.alloc(31).toString("base64"))).toThrow(/32-byte/);
    expect(encryptionKey(key.toString("base64"))).toEqual(key);
  });

  it("stores ciphertext only and isolates tenant/name through authenticated data", async () => {
    const store = new PostgresSecretStore(db, key);
    await store.set("alpha", "EIL_JIRA_TOKEN", "top-secret-value");
    expect(await store.get("alpha", "EIL_JIRA_TOKEN")).toBe("top-secret-value");
    expect(await store.get("beta", "EIL_JIRA_TOKEN")).toBeNull();
    const raw = await db.query(
      "SELECT encode(ciphertext, 'escape') AS ciphertext, octet_length(nonce) AS nonce_len," +
        " octet_length(auth_tag) AS tag_len FROM secrets.connector_credentials",
    );
    expect(raw.rows[0].ciphertext).not.toContain("top-secret-value");
    expect(Number(raw.rows[0].nonce_len)).toBe(12);
    expect(Number(raw.rows[0].tag_len)).toBe(16);
    await expect(
      new PostgresSecretStore(db, randomBytes(32)).get("alpha", "EIL_JIRA_TOKEN"),
    ).rejects.toThrow(/decryption failed/);
  });

  it("default dump arguments structurally exclude secrets", () => {
    expect(secretFreeDumpArgs("postgresql:///eil", "eil.dump")).toEqual([
      "--dbname",
      "postgresql:///eil",
      "--exclude-schema=secrets",
      "--format=custom",
      "--file",
      "eil.dump",
    ]);
  });

  it("PGlite policy check asserts SET ROLE happened and API reads fail", async () => {
    await db.query("SET ROLE eil_api");
    const who = await db.query("SELECT current_user AS name");
    expect(who.rows[0].name).toBe("eil_api");
    await expect(db.query("SELECT * FROM secrets.connector_credentials")).rejects.toThrow();
    await db.query("RESET ROLE");
    await db.query("SET ROLE eil_connector_worker");
    const worker = await db.query("SELECT current_user AS name");
    expect(worker.rows[0].name).toBe("eil_connector_worker");
    expect(
      (await db.query("SELECT count(*) AS n FROM secrets.connector_credentials")).rows[0].n,
    ).toBeDefined();
    await db.query("RESET ROLE");
  });
});
