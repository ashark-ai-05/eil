import { afterEach, describe, expect, it } from "vitest";
import { makeClient } from "../connectors/auth.js";

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
