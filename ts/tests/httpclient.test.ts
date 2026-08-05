/**
 * scopedFetch must actually route through a configured proxy and actually
 * bypass it for NO_PROXY hosts — not just construct an agent and hope. Each
 * test runs real HTTP servers rather than mocking undici internals, because
 * the property that matters is observable request routing.
 */
import { createServer } from "node:http";
import { type AddressInfo, connect as netConnect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeScopedFetch, scopedFetch } from "../connectors/httpclient.js";

interface Probe {
  url: string;
  hit: boolean;
  close: () => Promise<void>;
}

/** A server that just records whether it was reached and says so. */
async function probe(label: string): Promise<Probe> {
  const state = { hit: false };
  const server = createServer((_req, res) => {
    state.hit = true;
    res.writeHead(200).end(label);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get hit() {
      return state.hit;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A real, minimal CONNECT-tunneling proxy — not a stand-in. undici's
 * ProxyAgent tunnels via HTTP CONNECT by default even for plain-http
 * targets (`proxyTunnel` defaults to true), so a proxy fake that only
 * answers plain GETs never receives a request and the client hangs waiting
 * on a CONNECT response that never comes.
 */
async function tunnelProxy(): Promise<Probe> {
  const state = { hit: false };
  const server = createServer();
  server.on("connect", (req, clientSocket, head) => {
    state.hit = true;
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = netConnect(Number(portStr), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get hit() {
      return state.hit;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const PROXY_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of PROXY_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // EnvHttpProxyAgent reads env vars at construction; force a fresh one per
  // test so env changes made in the test actually take effect.
  await closeScopedFetch();
});

afterEach(async () => {
  for (const k of PROXY_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeScopedFetch();
});

describe("scopedFetch", () => {
  it("reaches the target directly when no proxy is configured", async () => {
    const target = await probe("direct");
    try {
      const res = await scopedFetch(target.url);
      expect(await res.text()).toBe("direct");
      expect(target.hit).toBe(true);
    } finally {
      await target.close();
    }
  });

  it("routes through HTTP_PROXY when configured", async () => {
    const proxy = await tunnelProxy();
    const target = await probe("direct");
    try {
      process.env.HTTP_PROXY = proxy.url;
      const res = await scopedFetch(target.url);
      // The proxy tunnels bytes rather than serving its own response, so a
      // successful reply body proves the tunnel actually carried the
      // request through to the target rather than short-circuiting.
      expect(await res.text()).toBe("direct");
      expect(proxy.hit).toBe(true);
      expect(target.hit).toBe(true);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("bypasses the proxy for a NO_PROXY host", async () => {
    const proxy = await tunnelProxy();
    const target = await probe("direct");
    try {
      process.env.HTTP_PROXY = proxy.url;
      process.env.NO_PROXY = "127.0.0.1";
      const res = await scopedFetch(target.url);
      expect(await res.text()).toBe("direct");
      expect(target.hit).toBe(true);
      expect(proxy.hit).toBe(false);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("does not mutate global fetch behavior", async () => {
    // The whole point of a scoped dispatcher: a plain global fetch() call,
    // made without going through scopedFetch at all, must still reach its
    // target directly even while HTTP_PROXY is set and scopedFetch has
    // already been used once in this process.
    const proxy = await tunnelProxy();
    const target = await probe("direct");
    try {
      process.env.HTTP_PROXY = proxy.url;
      await scopedFetch(target.url); // establishes the scoped agent, uses the proxy
      expect(proxy.hit).toBe(true);

      const directTarget = await probe("direct-2");
      try {
        const res = await fetch(directTarget.url); // global fetch, untouched
        expect(await res.text()).toBe("direct-2");
        expect(directTarget.hit).toBe(true);
      } finally {
        await directTarget.close();
      }
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("closeScopedFetch tears down and a subsequent call still works", async () => {
    const target = await probe("direct");
    try {
      await scopedFetch(target.url);
      await closeScopedFetch();
      await closeScopedFetch(); // idempotent — no dispatcher to close the second time
      const res = await scopedFetch(target.url);
      expect(await res.text()).toBe("direct");
    } finally {
      await target.close();
    }
  });
});
