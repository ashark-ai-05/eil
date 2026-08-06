/**
 * `eil doctor` must turn a corp-network first run into a specific, safe
 * diagnostic rather than an opaque timeout. Pure-logic checks are tested
 * directly; the database check is exercised against a real PGlite catalog
 * (reachable) and a closed port (unreachable), the two states an operator
 * actually hits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fetcher } from "../connectors/auth.js";
import {
  classifyFetchError,
  connectorCredentialChecks,
  nodeVersionCheck,
  proxyEnvCheck,
  redactUrl,
  runDoctor,
  scrubSecrets,
} from "../doctor.js";

const jsonOk = (body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("nodeVersionCheck", () => {
  it("accepts the declared floor and above", () => {
    expect(nodeVersionCheck("v22.0.0").ok).toBe(true);
    expect(nodeVersionCheck("v22.19.0").ok).toBe(true);
    expect(nodeVersionCheck("v24.1.0").ok).toBe(true);
  });

  it("rejects below the floor, naming the requirement", () => {
    const r = nodeVersionCheck("v18.20.4");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(">=22");
  });
});

describe("proxyEnvCheck", () => {
  it("reports direct connections when nothing is set", () => {
    const r = proxyEnvCheck({});
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("direct");
  });

  it("redacts embedded credentials and reflects NO_PROXY", () => {
    const r = proxyEnvCheck({
      HTTP_PROXY: "http://user:secret@proxy.corp.internal:8080",
      NO_PROXY: "localhost,127.0.0.1",
    });
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain("secret");
    expect(r.detail).not.toContain("user");
    expect(r.detail).toContain("***@proxy.corp.internal");
    expect(r.detail).toContain("NO_PROXY=localhost,127.0.0.1");
  });

  it("names NO_PROXY as unset when a proxy is configured without one", () => {
    const r = proxyEnvCheck({ HTTPS_PROXY: "http://proxy.corp.internal:8080" });
    expect(r.detail).toContain("NO_PROXY not set");
  });
});

describe("redactUrl", () => {
  it("masks user:pass userinfo, leaves a plain URL untouched", () => {
    expect(redactUrl("https://tok:xyz@jira.example.com/")).toBe("https://***@jira.example.com/");
    expect(redactUrl("https://jira.example.com/")).toBe("https://jira.example.com/");
  });

  it("masks username-only userinfo — a bare token in that position is exactly as sensitive", () => {
    expect(redactUrl("https://AKIAIOSFODNN7EXAMPLE@jira.example.com/")).toBe(
      "https://***@jira.example.com/",
    );
  });

  it("masks percent-encoded userinfo", () => {
    // "p@ss" encoded as password — the WHATWG URL parser decodes this
    // correctly on the way in, and we never echo it back.
    const r = redactUrl("https://user:p%40ss@jira.example.com/");
    expect(r).not.toContain("p@ss");
    expect(r).not.toContain("p%40ss");
    expect(r).toBe("https://***@jira.example.com/");
  });

  it("redacts credential-shaped query parameters case-insensitively", () => {
    const r = redactUrl(
      "https://jira.example.com/rest?token=abc123&api_key=def456&Access_Token=ghi&unrelated=keep",
    );
    expect(r).not.toContain("abc123");
    expect(r).not.toContain("def456");
    expect(r).not.toContain("ghi");
    expect(r).toContain("unrelated=keep");
    expect(r).toContain("token=***");
    expect(r).toContain("api_key=***");
    expect(r).toContain("Access_Token=***");
  });

  it("returns a safe placeholder for malformed, credential-shaped input rather than echoing it", () => {
    const r = redactUrl("not a url but has token=abc123-secret in it");
    expect(r).not.toContain("abc123-secret");
    expect(r).toBe("<unparseable-url>");
  });
});

describe("classifyFetchError", () => {
  it("names DNS, refusal, timeout and TLS failures specifically", () => {
    expect(classifyFetchError({ cause: { code: "ENOTFOUND" } })).toBe("DNS resolution failed");
    expect(classifyFetchError({ cause: { code: "ECONNREFUSED" } })).toBe("connection refused");
    expect(classifyFetchError({ name: "AbortError" })).toBe("timed out");
    const tls = classifyFetchError({ cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });
    expect(tls).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("never suggests disabling certificate verification", () => {
    const tls = classifyFetchError({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    expect(tls.toLowerCase()).not.toMatch(/set\s+node_tls_reject_unauthorized/);
  });

  it("falls back to the first line of an unrecognized error, not the full stack", () => {
    const err = new Error("boom\nat someInternalFrame (/deep/stack.js:1:1)");
    expect(classifyFetchError(err)).toBe("boom");
  });

  it("scrubs a credential-bearing URL embedded in an unrecognized error's message", () => {
    const err = new Error(
      "fetch failed for https://user:hunter2@jira.example.com/rest?token=abc123\nat fetch (node:internal)",
    );
    const detail = classifyFetchError(err);
    expect(detail).not.toContain("hunter2");
    expect(detail).not.toContain("abc123");
    expect(detail).toContain("***@jira.example.com");
  });
});

describe("scrubSecrets — PostgreSQL DSN shapes", () => {
  it("redacts a password embedded in a postgresql:// connection string", () => {
    const msg =
      'password authentication failed for "postgresql://eil:hunter2@db.corp.internal:5432/eil"';
    const r = scrubSecrets(msg);
    expect(r).not.toContain("hunter2");
    expect(r).toContain("***@db.corp.internal");
  });

  it("redacts a token query parameter in a driver error mentioning a DSN", () => {
    const msg = "connection failed: postgresql://db.corp.internal/eil?sslmode=require&token=xyz789";
    const r = scrubSecrets(msg);
    expect(r).not.toContain("xyz789");
    expect(r).toContain("token=***");
    expect(r).toContain("sslmode=require");
  });
});

describe("connectorCredentialChecks", () => {
  it("reports env-sourced tokens as present without touching the keychain", () => {
    const checks = connectorCredentialChecks({ EIL_JIRA_TOKEN: "pat-123" });
    const jira = checks.find((c) => c.name === "credential:jira")!;
    expect(jira.ok).toBe(true);
    expect(jira.detail).toContain("set via environment");
    expect(jira.detail).not.toContain("pat-123");
  });

  it("reports an unconfigured connector as OK with presence explicitly unknown, not established", () => {
    const checks = connectorCredentialChecks({});
    const confluence = checks.find((c) => c.name === "credential:confluence")!;
    expect(confluence.ok).toBe(true);
    expect(confluence.detail).toContain("not in environment");
    expect(confluence.detail).toContain("presence unknown");
    expect(confluence.detail).toContain("keychain");
  });
});

describe("runDoctor — authenticated connector readiness", () => {
  const noKeychain = () => null; // explicit no-op: proves isolation, not just absence of a real credential

  it("reports a configured URL with no credentials as blocked, without making a network call", async () => {
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return jsonOk();
    };
    const report = await runDoctor({ EIL_JIRA_URL: "https://127.0.0.1:1" }, fetcher, noKeychain);
    const auth = report.checks.find((c) => c.name === "auth:jira")!;
    expect(auth.ok).toBe(false);
    expect(auth.blocked).toEqual({ reason: "missing_credentials" });
    expect(auth.detail).not.toContain("authentication rejected"); // distinct from a real auth failure
    expect(called).toBe(false);
  });

  it("reports success when the token is present and the probe's minimal authenticated request succeeds", async () => {
    const fetcher: Fetcher = async (url) => {
      expect(String(url)).toContain("/rest/api/2/myself"); // the real production probe path, not a stand-in
      return jsonOk({ name: "asha" });
    };
    const report = await runDoctor(
      { EIL_JIRA_URL: "https://127.0.0.1:1", EIL_JIRA_TOKEN: "pat-123" },
      fetcher,
      noKeychain,
    );
    const auth = report.checks.find((c) => c.name === "auth:jira")!;
    expect(auth.ok).toBe(true);
    expect(auth.blocked).toBeUndefined();
  });

  it("distinguishes a rejected token (401/403) from a blocked/missing-credentials state", async () => {
    const fetcher: Fetcher = async () => new Response("nope", { status: 401 });
    const report = await runDoctor(
      { EIL_JIRA_URL: "https://127.0.0.1:1", EIL_JIRA_TOKEN: "stale-token" },
      fetcher,
      noKeychain,
    );
    const auth = report.checks.find((c) => c.name === "auth:jira")!;
    expect(auth.ok).toBe(false);
    expect(auth.blocked).toBeUndefined();
    expect(auth.detail).toContain("authentication rejected (401)");
  });

  it("skips entirely for a source with no configured URL — same as the existing reachability check", async () => {
    const report = await runDoctor({}, async () => jsonOk(), noKeychain);
    expect(report.checks.some((c) => c.name.startsWith("auth:"))).toBe(false);
  });

  it("credentials are never present in a check's serialized output, even on success", async () => {
    const fetcher: Fetcher = async () => jsonOk({ name: "asha" });
    const report = await runDoctor(
      { EIL_JIRA_URL: "https://127.0.0.1:1", EIL_JIRA_TOKEN: "super-secret-pat" },
      fetcher,
      noKeychain,
    );
    expect(JSON.stringify(report)).not.toContain("super-secret-pat");
  });

  // The bug the previous round left in place: makeClient's fallback chain
  // (token ?? keychain(...) ?? env[...]) meant an injected `env` that OMITS
  // a token still fell through to the REAL process.env/keychain underneath
  // it. This is the actual regression — an ambient credential is set for
  // real, and the injected env deliberately omits it — proving the new
  // explicit CredentialSource genuinely isolates rather than merely
  // happening to pass because nothing ambient existed to leak.
  describe("isolation from the real ambient environment", () => {
    const savedToken = process.env.EIL_JIRA_TOKEN;
    const savedUser = process.env.EIL_JIRA_USER;
    afterEach(() => {
      if (savedToken === undefined) delete process.env.EIL_JIRA_TOKEN;
      else process.env.EIL_JIRA_TOKEN = savedToken;
      if (savedUser === undefined) delete process.env.EIL_JIRA_USER;
      else process.env.EIL_JIRA_USER = savedUser;
    });

    it("an ambient EIL_JIRA_TOKEN/EIL_JIRA_USER cannot leak into an injected env that omits them", async () => {
      process.env.EIL_JIRA_TOKEN = "ambient-real-token-should-never-be-used";
      process.env.EIL_JIRA_USER = "ambient-real-user-should-never-be-used";
      let called = false;
      const fetcher: Fetcher = async () => {
        called = true;
        return jsonOk();
      };
      const report = await runDoctor({ EIL_JIRA_URL: "https://127.0.0.1:1" }, fetcher, noKeychain);
      const auth = report.checks.find((c) => c.name === "auth:jira")!;
      expect(auth.blocked).toEqual({ reason: "missing_credentials" });
      expect(called).toBe(false);
    });

    it("an injected keychain resolver IS honored — the point of isolation is a real substitute path, not a dead end", async () => {
      let called = false;
      const fetcher: Fetcher = async (url) => {
        called = true;
        expect(String(url)).toContain("/rest/api/2/myself");
        return jsonOk({ name: "asha" });
      };
      const injectedKeychain = (account: string) =>
        account === "EIL_JIRA_TOKEN" ? "keychain-supplied-token" : null;
      const report = await runDoctor(
        { EIL_JIRA_URL: "https://127.0.0.1:1" }, // no env token — must come from the injected keychain
        fetcher,
        injectedKeychain,
      );
      const auth = report.checks.find((c) => c.name === "auth:jira")!;
      expect(auth.ok).toBe(true);
      expect(called).toBe(true);
    });
  });
});

describe("runDoctor — database check", () => {
  // dbCheck() reads process.env.EIL_DATABASE_URL directly via db.ts's dsn(),
  // the same as every other command — runDoctor's `env` param feeds the
  // other checks but can't override this one without changing db.ts's
  // established convention, so the test sets/restores the real env var.
  const dataDir = mkdtempSync(join(tmpdir(), "eil-doctor-pglite-"));
  const originalUrl = process.env.EIL_DATABASE_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.EIL_DATABASE_URL;
    else process.env.EIL_DATABASE_URL = originalUrl;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports reachable + up to date against a freshly migrated PGlite catalog", async () => {
    const { migrate, connect } = await import("../db.js");
    process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
    const client = await connect();
    await migrate(client);
    await client.end();

    const report = await runDoctor();
    const db = report.checks.find((c) => c.name === "database")!;
    expect(db.ok).toBe(true);
    expect(db.detail).toContain("up to date");
  });

  it("reports a specific, non-crashing failure when the database is unreachable", async () => {
    // Port 1 is a reserved low port nothing listens on in this sandbox.
    process.env.EIL_DATABASE_URL = "postgresql://eil:eil@127.0.0.1:1/eil";
    const report = await runDoctor();
    const db = report.checks.find((c) => c.name === "database")!;
    expect(db.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});
