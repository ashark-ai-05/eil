/**
 * Detect -> quarantine -> redact. The unit half; the pipeline half (a
 * quarantined document is never chunked, so no tsv/embedding/snippet can hold
 * the secret) is asserted in pglite.test.ts against a real database.
 */
import { describe, expect, it } from "vitest";
import { entropy, redact, scanSecrets } from "../ingest/secrets.js";

describe("secret detection", () => {
  it("finds registered credential shapes", () => {
    const body = [
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      "token: ghp_16CharsMinimumxxxxxxxxxxxxxxxxxxxxxx",
      "-----BEGIN RSA PRIVATE KEY-----",
      "DATABASE_URL=postgres://svc:s3cr3tpassw0rd@db.internal:5432/app",
    ].join("\n");
    const rules = scanSecrets(body).map((f) => f.rule);
    expect(rules).toContain("aws-access-key-id");
    expect(rules).toContain("github-token");
    expect(rules).toContain("private-key-block");
    expect(rules).toContain("connection-string-password");
  });

  it("never puts the secret in the finding — only a locating hint", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const [f] = scanSecrets(`key = ${secret}`);
    expect(f).toBeDefined();
    expect(JSON.stringify(f)).not.toContain(secret);
    expect(f!.hint).toBe("AKIA…MPLE");
  });

  it("does not flag placeholders, which is what makes the gate usable", () => {
    const body = [
      'api_key = "your_api_key_here"',
      'password: "${DB_PASSWORD}"',
      'secret = "xxxxxxxxxxxxxxxxxxxx"',
      'token: "<your-token>"',
    ].join("\n");
    expect(scanSecrets(body)).toEqual([]);
  });

  it("does not flag ordinary prose or code", () => {
    const body = [
      "The retry policy uses exponential backoff with a 30 second cap.",
      "const handler = new RetryHandler({ maxAttempts: 5 });",
      "See https://confluence.corp/pages/12345 for the runbook.",
    ].join("\n");
    expect(scanSecrets(body)).toEqual([]);
  });

  it("flags a high-entropy value only in an assignment context", () => {
    const random = "kJ8xQ2mZvP4nR7wT1yB6cD9fG3hL5sA0";
    expect(scanSecrets(`api_secret = "${random}"`).map((f) => f.rule)).toEqual([
      "high-entropy-assignment",
    ]);
    // the same string as free text is a hash, an id, an asset — not a credential
    expect(scanSecrets(`the build produced ${random} as its digest`)).toEqual([]);
  });

  it("merges overlapping findings so redaction never nests", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";
    const found = scanSecrets(`auth_token = "${jwt}"`);
    for (let i = 1; i < found.length; i++) {
      expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
    }
    expect(redact(`auth_token = "${jwt}"`, found)).not.toContain("eyJhbGci");
  });

  it("redacts every span and leaves the rest intact", () => {
    const body =
      "before AKIAIOSFODNN7EXAMPLE middle ghp_16CharsMinimumxxxxxxxxxxxxxxxxxxxxxx after";
    const out = redact(body, scanSecrets(body));
    expect(out).toContain("before ");
    expect(out).toContain(" middle ");
    expect(out).toContain(" after");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[redacted:aws-access-key-id]");
  });

  // Pins the calibration rather than a comfortable claim. Entropy does NOT
  // separate secrets from benign values — measured, the distributions overlap
  // (lowest secret 2.72, highest benign 3.85). The shape rules carry the weight,
  // and the low-entropy secrets below are precisely the ones they catch.
  it("entropy is a weak signal: the distributions genuinely overlap", () => {
    expect(entropy("kJ8xQ2mZvP4nR7wT1yB6cD9fG3hL5sA0")).toBeGreaterThan(4.5); // random
    expect(entropy("ghp_16CharsMinimumxxxxxxxxxxxxxxxxxxxxxx")).toBeLessThan(3.0); // a real token
    expect(entropy("postgres_production_readonly")).toBeGreaterThan(3.5); // benign, scores high
    // so the token above is caught by SHAPE, never by entropy:
    expect(scanSecrets("x = ghp_16CharsMinimumxxxxxxxxxxxxxxxxxxxxxx")[0]!.rule).toBe(
      "github-token",
    );
  });
});
