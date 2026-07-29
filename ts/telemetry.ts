/**
 * OpenTelemetry traces. Off by default, zero cost when disabled.
 *
 * WHY TRACES AND NOT METRICS. EIL's metrics are SQL views over durable facts in
 * the same Postgres, and that stays. Prometheus's own documentation disqualifies
 * it for this workload — "if you need 100% accuracy, such as for per-request
 * billing, Prometheus is not a good choice" — and metrics.usage_facts IS
 * per-request billing. Traces are lossy by design too: head sampling cannot
 * guarantee capture. So anything that must be complete lives in Postgres,
 * unsampled.
 *
 * But tables cannot express causality. audit_log can say a search took 900 ms;
 * it cannot say 700 ms of that was the vector arm scanning because the ACL
 * predicate was not index-usable. That is what spans are for, and it was the
 * remaining blind spot. The two join on audit_log.trace_id, which step 0 added.
 *
 * THREE CONSTRAINTS SPECIFIC TO THIS PROCESS SHAPE:
 *
 * 1. A stdio MCP server must NEVER write telemetry to stdout. ConsoleSpanExporter,
 *    a stray console.log, or the OTel diag logger's default sink all corrupt the
 *    JSON-RPC framing on fd 1 and hang the client. Asserted by a test.
 * 2. A CLI is short-lived and BatchSpanProcessor drops spans on exit, so
 *    shutdown must force-flush.
 * 3. The SDK must not be imported unless enabled — tens of MB of module graph on
 *    every CLI invocation is the single biggest cost of instrumenting a CLI.
 *    App code imports only @opentelemetry/api, whose no-op implementations are
 *    shared singletons when no SDK is registered.
 */

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  recordError(err: unknown): void;
  end(): void;
}

/** Trace and span id for the current span, or nulls when tracing is off. */
export interface TraceContext {
  traceId: string | null;
  spanId: string | null;
}

const NOOP_SPAN: SpanLike = {
  setAttribute() {},
  recordError() {},
  end() {},
};

let enabled = false;
let tracer: unknown = null;

/**
 * Semantic-convention attribute names, wrapped rather than used inline.
 *
 * The GenAI conventions MOVED out of the main semconv repo into
 * `semantic-conventions-genai`, and everything in it is Development stability —
 * so these names will change. One module to edit when they do.
 */
export const ATTR = {
  operation: "gen_ai.operation.name",
  dataSource: "gen_ai.data_source.id",
  toolName: "gen_ai.tool.name",
  provider: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  mcpMethod: "mcp.method.name",
  mcpSession: "mcp.session.id",
  transport: "network.transport",
  errorType: "error.type",
} as const;

export const OP = {
  retrieval: "retrieval",
  embeddings: "embeddings",
  executeTool: "execute_tool",
  chat: "chat",
} as const;

/**
 * Start tracing if EIL_OTEL is set. Safe to call when the SDK is absent — the
 * optional dependency simply is not there, and everything stays no-op.
 */
export async function initTelemetry(): Promise<boolean> {
  if (enabled) return true;
  if (!process.env.EIL_OTEL) return false;
  try {
    const apiName = "@opentelemetry/api"; // variable specifier: optional dep
    const api: any = await import(apiName);
    const sdkName = "@opentelemetry/sdk-node"; // variable specifier: optional dep
    const { NodeSDK }: any = await import(sdkName);
    const protoName = "@opentelemetry/exporter-trace-otlp-proto";
    const { OTLPTraceExporter }: any = await import(protoName);

    // NEVER a console exporter. On stdio this writes to fd 1 and corrupts the
    // JSON-RPC frame; the diag logger is pinned to stderr for the same reason.
    api.diag.setLogger(
      { verbose() {}, debug() {}, info() {}, warn: console.error, error: console.error },
      api.DiagLogLevel.WARN,
    );
    const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
    sdk.start();
    // A CLI exits before BatchSpanProcessor flushes, so force it.
    const flush = async () => {
      try {
        await sdk.shutdown();
      } catch {
        /* never let telemetry teardown fail the command */
      }
    };
    process.once("beforeExit", flush);
    process.once("SIGINT", flush);
    process.once("SIGTERM", flush);
    tracer = api.trace.getTracer("eil");
    enabled = true;
    return true;
  } catch (err: any) {
    // Missing optional dependency or a misconfigured exporter must never break
    // a search. Telemetry is an observation of the system, not part of it.
    console.error(`telemetry disabled: ${err.message}`);
    return false;
  }
}

/**
 * Run `fn` inside a span. When tracing is off this is a direct call with one
 * boolean check — no allocation, no context propagation.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  if (!enabled || !tracer) return fn(NOOP_SPAN);
  const apiName = "@opentelemetry/api";
  const api: any = await import(apiName);
  return (tracer as any).startActiveSpan(name, async (raw: any) => {
    const span: SpanLike = {
      setAttribute: (k, v) => raw.setAttribute(k, v),
      recordError: (e) => {
        raw.recordException(e as Error);
        raw.setStatus({ code: api.SpanStatusCode.ERROR });
      },
      end: () => raw.end(),
    };
    for (const [k, v] of Object.entries(attrs)) raw.setAttribute(k, v);
    try {
      return await fn(span);
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      raw.end();
    }
  });
}

/**
 * Ids of the active span, for writing into audit_log.
 *
 * This is the join between the two worlds: 100% of calls are in the table, and
 * trace_id is populated for the sampled subset. The asymmetry is a feature —
 * complete facts plus cheap causality — which is why the audit write is never
 * sampled.
 */
export async function currentTrace(): Promise<TraceContext> {
  if (!enabled) return { traceId: null, spanId: null };
  try {
    const apiName = "@opentelemetry/api";
    const api: any = await import(apiName);
    const ctx = api.trace.getSpan(api.context.active())?.spanContext();
    return { traceId: ctx?.traceId ?? null, spanId: ctx?.spanId ?? null };
  } catch {
    return { traceId: null, spanId: null };
  }
}

export const telemetryEnabled = (): boolean => enabled;

/** Test seam only. */
export function __resetTelemetry(): void {
  enabled = false;
  tracer = null;
}
