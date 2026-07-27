import { afterEach, describe, expect, it } from "vitest";
import { makeClient } from "../connectors/auth.js";
import { deleteSecret, setSecret } from "../connectors/keychain.js";

afterEach(() => {
  delete process.env.EIL_JIRA_USER;
  delete process.env.EIL_BAMBOO_URL;
  delete process.env.EIL_BAMBOO_TOKEN;
});

describe("DC auth factory", () => {
  it("defaults to Bearer PAT", () => {
    delete process.env.EIL_JIRA_USER;
    const client = makeClient("JIRA", "https://jira.example.com", "pat-123");
    expect(client.headers.Authorization).toBe("Bearer pat-123");
  });

  it("switches to Basic auth when EIL_<PREFIX>_USER is set", () => {
    process.env.EIL_JIRA_USER = "krunal";
    const client = makeClient("JIRA", "https://jira.example.com", "pat-123");
    expect(client.headers.Authorization).toBe(
      `Basic ${Buffer.from("krunal:pat-123").toString("base64")}`,
    );
  });

  it("reads env for any prefix (Bamboo-ready) and strips trailing slashes", () => {
    process.env.EIL_BAMBOO_URL = "https://bamboo.example.com/";
    process.env.EIL_BAMBOO_TOKEN = "t";
    const client = makeClient("BAMBOO");
    expect(client.baseUrl).toBe("https://bamboo.example.com");
  });

  it("fails with a named error when env is missing", () => {
    expect(() => makeClient("NOPE")).toThrow(/EIL_NOPE_URL/);
  });
});

describe("token resolution precedence", () => {
  afterEach(() => {
    delete process.env.EIL_KEYCHAIN_BACKEND;
    delete process.env.EIL_JIRA_TOKEN;
    deleteSecret("EIL_JIRA_TOKEN");
  });

  it("prefers the keychain over the env var", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    setSecret("EIL_JIRA_TOKEN", "from-keychain");
    process.env.EIL_JIRA_TOKEN = "from-env";
    const client = makeClient("JIRA", "https://jira.example.com");
    expect(client.headers.Authorization).toBe("Bearer from-keychain");
  });

  it("falls back to the env var when the keychain has no entry", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    deleteSecret("EIL_JIRA_TOKEN");
    process.env.EIL_JIRA_TOKEN = "from-env";
    const client = makeClient("JIRA", "https://jira.example.com");
    expect(client.headers.Authorization).toBe("Bearer from-env");
  });

  it("lets an explicit token arg win over both", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    setSecret("EIL_JIRA_TOKEN", "from-keychain");
    const client = makeClient("JIRA", "https://jira.example.com", "explicit");
    expect(client.headers.Authorization).toBe("Bearer explicit");
  });

  it("throws an actionable error when no token is found", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    delete process.env.EIL_JIRA_TOKEN;
    deleteSecret("EIL_JIRA_TOKEN");
    expect(() => makeClient("JIRA", "https://jira.example.com")).toThrow(/eil auth login jira/);
  });
});
