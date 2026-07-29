/**
 * The shape `[A-Z][A-Z0-9]{1,9}-\d+` matched 10 of 15 ordinary technical tokens.
 * That polluted `links` and inflated links_dangling_dst, and — because the
 * router used the same shape — sent "UTF-8 encoding" to the entity executor to
 * look up a Jira ticket that cannot exist, instead of searching.
 *
 * It matters more now that code ingest extracts links from source files, where
 * these tokens are dense.
 */
import { describe, expect, it } from "vitest";
import { classify } from "../core/router.js";
import { isTicketKey, ticketKeys } from "../core/ticket.js";

describe("ticket key recognition", () => {
  it("rejects the standards and encodings that used to match", () => {
    for (const t of [
      "UTF-8",
      "SHA-256",
      "SHA-1",
      "ISO-8601",
      "AES-256",
      "HTTP-2",
      "RFC-7231",
      "CVE-2021",
      "BASE-64",
      "IPV-4",
      "OAUTH-2",
      "ES-6",
      "TLS-1",
    ])
      expect(isTicketKey(t), t).toBe(false);
  });

  it("still accepts real keys", () => {
    for (const t of ["PAY-981", "ENG-42", "PROJ123-7", "AB-1", "PLATFORM-10024"])
      expect(isTicketKey(t), t).toBe(true);
  });

  it("extracts only real keys from a mixed body", () => {
    const body =
      "Encode as UTF-8 and hash with SHA-256 before sending. Tracked in PAY-981, blocks ENG-42.";
    expect(ticketKeys(body)).toEqual(["PAY-981", "ENG-42"]);
  });

  it("an explicit project-key set bypasses the heuristic entirely", () => {
    // The deny-list is a heuristic; a caller that knows the real keys is exact.
    // Note this lets a genuinely-named project 'UTF' work, and rejects a key
    // the deny-list would have allowed.
    const keys = new Set(["UTF"]);
    expect(isTicketKey("UTF-8", keys)).toBe(true);
    expect(isTicketKey("PAY-981", keys)).toBe(false);
  });

  it("does not route a standards token to the entity executor", () => {
    expect(classify("UTF-8 encoding of the payload").route).not.toBe("entity");
    expect(classify("SHA-256 collision resistance").route).not.toBe("entity");
    expect(classify("PAY-981").route).toBe("entity");
    expect(classify("PAY-981").match).toBe("PAY-981");
  });
});
