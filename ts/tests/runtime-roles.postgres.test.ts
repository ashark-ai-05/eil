/** Real-PostgreSQL gate: PGlite cannot prove separate-connection privileges. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, connect, connectRuntime, dsn, migrate, provisionRuntimeRoles } from "../db.js";

const DATABASE = "eil_ts_runtime_roles";
const API_LOGIN = "eil_test_api_login";
const WORKER_LOGIN = "eil_test_worker_login";
let available = true;
let admin: Db;
let databaseAdmin: Db;

const loginDsn = (base: string, user: string, password: string): string => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${DATABASE}`;
  return url.toString();
};

try {
  admin = await connect("postgres");
} catch {
  available = false;
}

beforeAll(async () => {
  if (!available) return;
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${API_LOGIN}`);
  await admin.query(`DROP ROLE IF EXISTS ${WORKER_LOGIN}`);
  await provisionRuntimeRoles(admin);
  await admin.query(`CREATE ROLE ${API_LOGIN} LOGIN PASSWORD 'test-api-password'`);
  await admin.query(`CREATE ROLE ${WORKER_LOGIN} LOGIN PASSWORD 'test-worker-password'`);
  await admin.query(`GRANT eil_api TO ${API_LOGIN}`);
  await admin.query(`GRANT eil_connector_worker TO ${WORKER_LOGIN}`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  databaseAdmin = await connect(DATABASE);
  await migrate(databaseAdmin);
});

afterAll(async () => {
  delete process.env.EIL_DATABASE_API_URL;
  delete process.env.EIL_DATABASE_WORKER_URL;
  if (!available) return;
  await databaseAdmin.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${API_LOGIN}`);
  await admin.query(`DROP ROLE IF EXISTS ${WORKER_LOGIN}`);
  await admin.end();
});

describe("real PostgreSQL runtime privilege boundary", () => {
  it("is available when the CI privilege gate is required", () => {
    if (process.env.EIL_REQUIRE_REAL_POSTGRES === "1") expect(available).toBe(true);
  });

  it.skipIf(!available)(
    "uses distinct non-superuser identities and denies API secret access",
    async () => {
      process.env.EIL_DATABASE_API_URL = loginDsn(dsn(), API_LOGIN, "test-api-password");
      process.env.EIL_DATABASE_WORKER_URL = loginDsn(dsn(), WORKER_LOGIN, "test-worker-password");
      const api = await connectRuntime("api");
      const worker = await connectRuntime("worker");
      try {
        const identities = await databaseAdmin.query(
          "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles" +
            " WHERE rolname IN ($1, $2) ORDER BY rolname",
          [API_LOGIN, WORKER_LOGIN],
        );
        expect(identities.rows).toEqual([
          { rolname: API_LOGIN, rolsuper: false, rolbypassrls: false },
          { rolname: WORKER_LOGIN, rolsuper: false, rolbypassrls: false },
        ]);
        expect((await api.query("SELECT current_user AS name")).rows[0].name).toBe(API_LOGIN);
        expect((await worker.query("SELECT current_user AS name")).rows[0].name).toBe(WORKER_LOGIN);
        await expect(api.query("SELECT * FROM secrets.connector_credentials")).rejects.toThrow();
        await worker.query(
          "INSERT INTO secrets.connector_credentials" +
            " (tenant,name,ciphertext,nonce,auth_tag,key_version) VALUES" +
            " ('default','probe','\\x01','\\x000000000000000000000000','\\x00000000000000000000000000000000',1)",
        );
        expect(
          (await worker.query("SELECT count(*) AS n FROM secrets.connector_credentials")).rows[0].n,
        ).toBe("1");
      } finally {
        await api.end();
        await worker.end();
      }
    },
  );
});
