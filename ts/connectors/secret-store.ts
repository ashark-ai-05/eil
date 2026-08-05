/** Credential boundary for local and hosted connector workers. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { Keychain } from "./keychain.js";

export interface SecretStore {
  get(tenant: string, name: string): Promise<string | null>;
  set(tenant: string, name: string, value: string): Promise<void>;
  delete(tenant: string, name: string): Promise<void>;
}

export class KeychainSecretStore implements SecretStore {
  constructor(private readonly keychain: Keychain) {}
  async get(_tenant: string, name: string): Promise<string | null> {
    return this.keychain.get(name);
  }
  async set(_tenant: string, name: string, value: string): Promise<void> {
    this.keychain.set(name, value);
  }
  async delete(_tenant: string, name: string): Promise<void> {
    this.keychain.delete(name);
  }
}

const aad = (tenant: string, name: string, version: number) =>
  Buffer.from(`${tenant}\0${name}\0${version}`, "utf8");

export function encryptionKey(encoded: string | undefined = process.env.EIL_SECRETS_KEK): Buffer {
  if (!encoded) throw new Error("missing env: EIL_SECRETS_KEK");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("EIL_SECRETS_KEK must be a base64-encoded 32-byte key");
  return key;
}

/** Stores ciphertext only. The worker supplies the KEK; PostgreSQL never does. */
export class PostgresSecretStore implements SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly keyVersion = 1,
  ) {
    if (key.length !== 32) throw new Error("secret-store encryption key must be exactly 32 bytes");
  }

  async get(tenant: string, name: string): Promise<string | null> {
    const result = await this.db.query(
      "SELECT ciphertext, nonce, auth_tag, key_version FROM secrets.connector_credentials" +
        " WHERE tenant = $1 AND name = $2",
      [tenant, name],
    );
    const row = result.rows[0];
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.nonce));
    decipher.setAAD(aad(tenant, name, Number(row.key_version)));
    decipher.setAuthTag(Buffer.from(row.auth_tag));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error(`credential decryption failed for ${name}`);
    }
  }

  async set(tenant: string, name: string, value: string): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad(tenant, name, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await this.db.query(
      "INSERT INTO secrets.connector_credentials" +
        " (tenant, name, ciphertext, nonce, auth_tag, key_version) VALUES ($1,$2,$3,$4,$5,$6)" +
        " ON CONFLICT (tenant, name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext," +
        " nonce=EXCLUDED.nonce, auth_tag=EXCLUDED.auth_tag," +
        " key_version=EXCLUDED.key_version, updated_at=now()",
      [tenant, name, ciphertext, nonce, cipher.getAuthTag(), this.keyVersion],
    );
  }

  async delete(tenant: string, name: string): Promise<void> {
    await this.db.query("DELETE FROM secrets.connector_credentials WHERE tenant=$1 AND name=$2", [
      tenant,
      name,
    ]);
  }
}

/** Default backup/export shape. Restores require explicit credential re-binding. */
export function secretFreeDumpArgs(databaseUrl: string, output: string): string[] {
  return ["--dbname", databaseUrl, "--exclude-schema=secrets", "--format=custom", "--file", output];
}
