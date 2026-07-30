/**
 * Traces complement the fact tables; they do not replace them. These assert the
 * three constraints specific to EIL's process shape, the most important of which
 * is that a stdio MCP server must never write telemetry to stdout — a span on
 * fd 1 corrupts the JSON-RPC framing and hangs the client, with no error.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import { type Viewer, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";
import {
  ATTR,
  OP,
  __resetTelemetry,
  currentTrace,
  initTelemetry,
  telemetryEnabled,
  withSpan,
} from "../telemetry.js";
import { callTool } from "../tools.js";

describe("off by default, and free when off", () => {
  it("does not enable itself without EIL_OTEL", async () => {
    __resetTelemetry();
    const saved = process.env.EIL_OTEL;
    delete process.env.EIL_OTEL;
    try {
      expect(await initTelemetry()).toBe(false);
      expect(telemetryEnabled()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.EIL_OTEL = saved;
    }
  });

  it("withSpan is a pass-through when disabled — no SDK, no allocation", async () => {
    __resetTelemetry();
    const out = await withSpan("x", { a: 1 }, async (span) => {
      span.setAttribute("ignored", "yes"); // must not throw on the no-op span
      return 42;
    });
    expect(out).toBe(42);
    expect(await currentTrace()).toEqual({ traceId: null, spanId: null });
  });

  it("propagates the callee's error rather than swallowing it", async () => {
    __resetTelemetry();
    await expect(
      withSpan("x", {}, async () => {
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
  });

  it("reports the SDK's availability honestly, and never throws either way", async () => {
    // @opentelemetry/* are optionalDependencies, so whether they resolve is a
    // property of the checkout, not of the code. Asserting one branch pins the
    // test to whichever machine wrote it — this one ran green for months only
    // because the deps had never been materialised. Telemetry is an observation
    // of the system, not part of it: a missing exporter must never break a
    // search, and a present one must not be silently ignored.
    const sdkName = "@opentelemetry/sdk-node";
    const installed = await import(sdkName).then(
      () => true,
      () => false,
    );

    __resetTelemetry();
    const saved = process.env.EIL_OTEL;
    process.env.EIL_OTEL = "1";
    try {
      expect(await initTelemetry()).toBe(installed);
    } finally {
      if (saved === undefined) delete process.env.EIL_OTEL;
      else process.env.EIL_OTEL = saved;
      __resetTelemetry();
    }
  });
});

describe("the stdio contract", () => {
  it("declares no console exporter anywhere", () => {
    // ConsoleSpanExporter writes spans to fd 1. Under stdio MCP that is the
    // JSON-RPC channel, so it corrupts the frame and hangs the client.
    const src = readFileSync(new URL("../telemetry.ts", import.meta.url), "utf-8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("ConsoleSpanExporter");
    expect(code).not.toContain("ConsoleMetricExporter");
    expect(code).not.toContain("console.log");
  });

  it("the MCP server emits ONLY JSON-RPC on stdout", () => {
    // The real protection: run the shipping server and inspect fd 1.
    let out = "";
    try {
      out = execFileSync("pnpm", ["-s", "eil", "serve"], {
        encoding: "utf-8",
        input: "", // EOF immediately
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, EIL_OTEL: "1", EIL_DATABASE_URL: "pglite://.eil-telemetry-probe" },
        timeout: 25_000,
      });
    } catch (err: any) {
      out = String(err.stdout ?? "");
    }
    for (const line of out.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow(); // anything non-JSON breaks the client
    }
    rmSync(".eil-telemetry-probe", { recursive: true, force: true });
  }, 40_000);
});

describe("the join key between spans and facts", () => {
  let client: Db;
  let dir: string;
  let saved: string | undefined;
  const VIEWER: Viewer = viewerFromAuthenticatedClaims({
    principal: userInfo().username,
    groups: [],
    tenant: "default",
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "eil-otel-"));
    saved = process.env.EIL_DATABASE_URL;
    process.env.EIL_DATABASE_URL = `pglite://${dir}`;
    client = await connect();
    await migrate(client);
    await upsertDocument(
      client,
      CanonicalDoc.parse({
        id: "confluence:page:otel",
        source: "confluence",
        title: "Retries",
        body: "Retries use exponential backoff.",
        aclGroups: [],
      }),
    );
  });
  afterAll(async () => {
    await client.end();
    if (saved === undefined) delete process.env.EIL_DATABASE_URL;
    else process.env.EIL_DATABASE_URL = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("audit_log always carries a trace_id, tracing on or off", async () => {
    // Without this the agent-facing trace_id would change meaning depending on
    // configuration — present sometimes, absent others.
    const res: any = await callTool("search_docs", { query: "retries" }, VIEWER, client);
    expect(res.trace_id).toBeTruthy();
    const row = await client.query("SELECT trace_id FROM audit_log ORDER BY id DESC LIMIT 1");
    expect(row.rows[0].trace_id).toBe(res.trace_id);
  });

  it("uses the documented semantic-convention attribute names", () => {
    // These MOVED to semantic-conventions-genai and are Development stability,
    // so they are wrapped in one module rather than inlined at each call site.
    expect(ATTR.operation).toBe("gen_ai.operation.name");
    expect(ATTR.mcpMethod).toBe("mcp.method.name");
    expect(ATTR.transport).toBe("network.transport");
    expect(OP.retrieval).toBe("retrieval");
    expect(OP.executeTool).toBe("execute_tool");
  });
});
