/**
 * Redirect handling for authenticated binary downloads.
 *
 * `getBytes` sends the connector's PAT on every request. The platform default,
 * `redirect: "follow"`, re-sends that header to whatever `Location` names — so
 * an attachment link that 302s to an external host hands the enterprise
 * credential to that host, and nothing in the returned bytes shows it happened.
 *
 * The property these tests protect is deliberately stronger than "we discarded
 * the response": it is that the second request is never SENT. That is why the
 * assertions count fetcher calls rather than only checking the thrown error.
 */
import { describe, expect, it } from "vitest";
import { type DcClient, MAX_REDIRECT_HOPS, getBytes } from "../connectors/auth.js";
import { RedirectRefused, ResponseTooLarge } from "../connectors/httperror.js";

const ORIGIN = "https://conf.corp";
const PDF = Buffer.from("%PDF-1.7 real bytes");

/** Records every URL the client actually requested, in order. */
function spyClient(handler: (url: URL) => Response): { client: DcClient; seen: URL[] } {
  const seen: URL[] = [];
  const client: DcClient = {
    baseUrl: ORIGIN,
    headers: { Authorization: "Bearer secret-pat" },
    fetcher: (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      seen.push(url);
      return handler(url);
    }) as DcClient["fetcher"],
  };
  return { client, seen };
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe("an authenticated download follows redirects only within its own origin", () => {
  it("follows a same-origin redirect and returns the final bytes", async () => {
    const { client, seen } = spyClient((url) =>
      url.pathname === "/download/a"
        ? redirectTo("/download/a-final")
        : new Response(PDF, { status: 200 }),
    );
    const out = await getBytes(client, "/download/a");
    expect(out.equals(PDF)).toBe(true);
    expect(seen.map((u) => u.pathname)).toEqual(["/download/a", "/download/a-final"]);
  });

  it("follows a same-origin ABSOLUTE redirect", async () => {
    const { client, seen } = spyClient((url) =>
      url.pathname === "/download/a"
        ? redirectTo(`${ORIGIN}/elsewhere/a`)
        : new Response(PDF, { status: 200 }),
    );
    expect((await getBytes(client, "/download/a")).equals(PDF)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("never sends a second authenticated request to another origin", async () => {
    // The whole point. One request goes out, the refusal happens on the
    // Location header, and evil.example never sees the token.
    const { client, seen } = spyClient(() => redirectTo("https://evil.example/steal"));
    await expect(getBytes(client, "/download/a")).rejects.toThrow(RedirectRefused);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe(ORIGIN);
  });

  it("refuses a protocol downgrade to the same host", async () => {
    // Same hostname, different scheme — a different origin, and a plaintext one
    // that would put the PAT on the wire.
    const { client, seen } = spyClient(() => redirectTo("http://conf.corp/download/a"));
    await expect(getBytes(client, "/download/a")).rejects.toThrow(/cross-origin/);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect to a different port on the same host", async () => {
    const { client, seen } = spyClient(() => redirectTo("https://conf.corp:8443/download/a"));
    await expect(getBytes(client, "/download/a")).rejects.toThrow(/cross-origin/);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect with no Location rather than treating it as a body", async () => {
    const { client } = spyClient(() => new Response(null, { status: 302 }));
    await expect(getBytes(client, "/download/a")).rejects.toThrow(/missing-location/);
  });

  it("stops a same-origin redirect loop at the hop bound", async () => {
    // Bounded, and reported as a LOOP rather than an escape attempt — the two
    // have different causes and a operator chasing the wrong one wastes time.
    const { client, seen } = spyClient(() => redirectTo("/download/round-and-round"));
    await expect(getBytes(client, "/download/a")).rejects.toThrow(/hop-limit/);
    expect(seen.length).toBe(MAX_REDIRECT_HOPS + 1);
  });

  it("applies the byte ceiling to a body-less response too", async () => {
    // The `arrayBuffer()` branch used to return unchecked, so whichever runtime
    // path produced a null `body` bypassed the ceiling entirely.
    const client: DcClient = {
      baseUrl: ORIGIN,
      headers: {},
      fetcher: async () => {
        const res = new Response(Buffer.from("x".repeat(100)), { status: 200 });
        Object.defineProperty(res, "body", { value: null });
        return res;
      },
    };
    await expect(getBytes(client, "/download/a", 10)).rejects.toThrow(ResponseTooLarge);
  });
});
