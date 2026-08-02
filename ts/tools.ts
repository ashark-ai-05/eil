/**
 * Framework-agnostic tool registry — the portability seam.
 * Defined once as zod schemas + handlers; hosts mount it however they like:
 * mcp-server.ts wraps it for stdio, the CLI calls callTool() directly, and
 * the work-side connector consumes the manifest (zod-to-json-schema) or
 * spawns the stdio server. callTool() is the single choke point: env gating,
 * DB session, ACL viewer, audit logging.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { type Db, connect } from "./db.js";
// (freshFetch imports its connectors lazily — no cost unless fresh=true is used)
import {
  type Viewer,
  audit,
  expand,
  getDoc,
  isTrustedViewer,
  localViewer,
  recordRetrieval,
  searchDocs,
} from "./search.js";
import { ATTR, OP, currentTrace, withSpan } from "./telemetry.js";

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: z.ZodObject<S>;
  requiresEnv: string[];
  handler: (
    client: Db,
    viewer: Viewer,
    args: Record<string, any>,
  ) => Promise<Record<string, unknown> | null>;
}

const searchDocsSpec: ToolSpec = {
  name: "search_docs",
  description:
    "Search indexed org knowledge (Confluence, Jira, notes, code) — the shape " +
    "of the response depends on how the query routes. Most queries return " +
    "compact `results`: id, title, snippet, `truncated`. `truncated: false` " +
    "means the snippet already contains the ENTIRE document — call get_doc " +
    "only when `truncated` is true and the snippet does not already answer " +
    "the question. A ticket key (e.g. PAY-981) instead resolves via the " +
    "entity route: `entity` (the document, itself windowed — see its own " +
    "`total_sections`) plus `linked` neighbors, with no `results` array and " +
    "no `truncated` field at all. A path/symbol/literal query resolves via " +
    "the code route: `results` are line-window code citations with no " +
    "`snippet` or per-result `truncated`; `context.truncated` there means the " +
    "total citation payload was cut to fit a budget, NOT that one citation is " +
    "incomplete — it is not the same flag as the docs-route `truncated` above.",
  schema: z.object({
    query: z.string(),
    limit: z.number().int().default(8),
    // Omit to search everything, which is almost always what an agent wants.
    // Naming sources is for a caller who already knows where the answer lives —
    // and for showing what a single-source connector can see on its own.
    sources: z.array(z.string()).optional(),
  }),
  requiresEnv: [],
  handler: (c, v, a) =>
    searchDocs(c, v, a.query, a.limit ?? 8, undefined, { sources: a.sources ?? null }),
};

/**
 * fresh=true pull-through (flow K5): re-fetch the doc live from its source
 * with personal credentials, re-index it, then serve it through the normal
 * ACL-filtered read. Falls back to the catalog copy (with a note) when the
 * source is unsupported or its env isn't configured.
 */
async function freshFetch(c: Db, viewer: Viewer, id: string): Promise<string | null> {
  try {
    if (id.startsWith("confluence:page:")) {
      if (!process.env.EIL_CONFLUENCE_URL) return "fresh unavailable: EIL_CONFLUENCE_URL not set";
      const { ConfluenceClient } = await import("./connectors/confluence.js");
      const { normalize } = await import("./ingest/confluence.js");
      const { upsertDocument } = await import("./store.js");
      const page = await new ConfluenceClient().getPage(id.slice("confluence:page:".length));
      await upsertDocument(c, normalize(page, viewer.tenant));
      return null;
    }
    if (id.startsWith("jira:issue:")) {
      if (!process.env.EIL_JIRA_URL) return "fresh unavailable: EIL_JIRA_URL not set";
      const { JiraClient } = await import("./connectors/jira.js");
      const { normalize } = await import("./ingest/jira.js");
      const { upsertDocument } = await import("./store.js");
      const issue = await new JiraClient().getIssue(id.slice("jira:issue:".length));
      await upsertDocument(c, normalize(issue, viewer.tenant));
      return null;
    }
    return `fresh unavailable: unsupported source for ${id}`;
  } catch (err: any) {
    return `fresh fetch failed: ${String(err.message).slice(0, 200)}`;
  }
}

const getDocSpec: ToolSpec = {
  name: "get_doc",
  description:
    "Fetch one document's content by canonical id (from search_docs/expand). " +
    "Large documents are windowed; pass section=1,2,... for more. This read " +
    "never refreshes or mutates the catalog. For a search_docs result from " +
    "the default (docs) route, call get_doc only when its `truncated` is " +
    "true and the snippet does not already answer the question — " +
    "`truncated: false` there means the snippet already IS the whole " +
    "document. Entity- and code-route search_docs results do not carry that " +
    "field (see search_docs's description for what each route returns " +
    "instead) — for those, call get_doc when the returned content does not " +
    "already answer the question.",
  schema: z.object({ id: z.string(), section: z.number().int().default(0) }).strict(),
  requiresEnv: [],
  handler: async (c, v, a) => {
    const doc = await getDoc(c, v, a.id, a.section ?? 0);
    return doc ?? { error: `not found: ${a.id}` };
  },
};

const refreshDocSpec: ToolSpec = {
  name: "refresh_doc",
  description:
    "Authorised connector refresh for one catalog document. Requires the eil-refresh group; this is audited and idempotent.",
  schema: z.object({ id: z.string() }),
  requiresEnv: [],
  handler: async (c, v, a) => {
    if (!v.groups.includes("eil-refresh"))
      return { error: "refresh_doc requires eil-refresh authorization" };
    // Resolve the document through the ACL *before* spending the server's
    // credentials on it. Fetching first made this a confused deputy: any holder
    // of eil-refresh could name an arbitrary Confluence page id or Jira key —
    // one not in the catalog at all — and have the process fetch and cache it
    // under the server's PAT. It also leaked an existence oracle, because a
    // missing id surfaced the connector's 404 text while an unreadable one
    // surfaced "not found after refresh", letting a caller enumerate ids they
    // cannot read. One opaque error for both, and no outbound call unless the
    // caller can already read the document.
    if (!(await getDoc(c, v, a.id))) return { error: `not found: ${a.id}` };
    const note = await freshFetch(c, v, a.id);
    if (note) return { error: note };
    return { id: a.id, status: "refreshed" };
  },
};

const expandSpec: ToolSpec = {
  name: "expand",
  description:
    "Link-graph neighborhood of a document: tickets, pages, and notes that " +
    "reference or are referenced by it. Zero-cost related context.",
  schema: z.object({ id: z.string() }),
  requiresEnv: [],
  handler: (c, v, a) => expand(c, v, a.id),
};

const searchCodeSpec: ToolSpec = {
  name: "search_code",
  description:
    "Search the locally indexed immutable repository corpus with deterministic, ACL-filtered path/symbol/literal/import/export/test citations.",
  schema: z.object({
    query: z.string(),
    kind: z.enum(["path", "symbol", "literal", "import", "export", "test"]).optional(),
    repo: z.string().optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
    limit: z.number().int().default(10),
  }),
  requiresEnv: [],
  handler: async (c, v, a) => (await import("./code-search.js")).searchCodeIndex(c, v, a as any),
};

const fetchLogsSpec: ToolSpec = {
  name: "fetch_logs",
  description:
    "Query production logs live from the logging ELK (never indexed here). " +
    "Lucene query_string syntax; recency-sorted, hard-capped.",
  schema: z.object({
    query: z.string(),
    minutes: z.number().int().default(60),
    limit: z.number().int().default(20),
    index: z.string().default(""),
  }),
  requiresEnv: ["EIL_ELK_URL", "EIL_ELK_TOKEN"],
  handler: async (_c, _v, a) => {
    const { ElkClient } = await import("./connectors/elk.js");
    return new ElkClient().fetchLogs(a.query, a.index || undefined, a.minutes ?? 60, a.limit ?? 20);
  },
};

export const REGISTRY: Record<string, ToolSpec> = Object.fromEntries(
  [searchDocsSpec, getDocSpec, refreshDocSpec, expandSpec, searchCodeSpec, fetchLogsSpec].map(
    (s) => [s.name, s],
  ),
);

export function manifest(): Record<string, unknown> {
  return {
    server: "eil-knowledge",
    tools: Object.values(REGISTRY).map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: zodToJsonSchema(spec.schema, { target: "jsonSchema7", $refStrategy: "none" }),
      requiresEnv: spec.requiresEnv,
    })),
  };
}

function resultCount(result: Record<string, unknown> | null): number {
  if (!result || typeof result !== "object") return 0;
  if (Array.isArray(result.results)) return result.results.length;
  if (Array.isArray(result.edges)) return result.edges.length;
  if ("entity" in result) {
    const linked = Array.isArray(result.linked) ? result.linked.length : 0;
    return (result.entity ? 1 : 0) + linked;
  }
  return result.error ? 0 : 1;
}

/** Dispatch a tool call with env gating, ACL viewer, and audit logging. */
export async function callTool(
  name: string,
  args: Record<string, any>,
  viewer?: Viewer,
  client?: Db,
): Promise<Record<string, unknown>> {
  const spec = REGISTRY[name];
  if (!spec) return { error: `unknown tool: ${name}`, tools: Object.keys(REGISTRY).sort() };
  const missing = spec.requiresEnv.filter((e) => !process.env[e]);
  if (missing.length > 0) return { error: `${name} not configured: set ${missing.join(" and ")}` };
  // Validate before opening any connection; return a clean error dict rather
  // than letting ZodError propagate (its message echoes caller-supplied values).
  const parsed = spec.schema.safeParse(args);
  if (!parsed.success) {
    return { error: `invalid arguments for ${name}`, issues: parsed.error.flatten().fieldErrors };
  }
  const v = viewer ?? localViewer();
  if (!isTrustedViewer(v)) {
    return { error: "untrusted viewer: construct context from verified authenticated claims" };
  }
  const ownsClient = client === undefined;
  const c = client ?? (await connect());
  // One trace id per tool call, returned to the caller so an agent's multi-call
  // task is reconstructable, and written to audit_log as the join key to spans.
  // A locally-minted id when tracing is off, the real span id when it is on, so
  // audit_log always has a correlation key and it JOINS to a span when one
  // exists. Losing the local id would mean the agent-facing trace_id changes
  // meaning depending on configuration.
  const started = Date.now();
  let traceId: string = randomUUID();
  let result: Record<string, unknown> = {};
  let ok = true;
  let error: string | undefined;
  try {
    result = await withSpan(
      `tools/call ${name}`,
      {
        [ATTR.mcpMethod]: "tools/call",
        [ATTR.operation]: OP.executeTool,
        [ATTR.toolName]: name,
        [ATTR.transport]: "pipe", // stdio; no other network attributes apply
      },
      async () => {
        const t = await currentTrace();
        if (t.traceId) traceId = t.traceId;
        return (await spec.handler(c, v, parsed.data)) ?? {};
      },
    );
    // A handler that returns {error} did not throw, but it did not succeed
    // either — an ACL denial reaching vw_zero_results as a legitimate
    // zero-result search is what corrupted the flagship adoption metric.
    if (typeof result.error === "string") {
      ok = false;
      error = result.error;
    }
    return { ...result, trace_id: traceId };
  } catch (err: any) {
    // Audit the failure rather than letting it vanish. Before this, audit() ran
    // after the handler, so ONLY successes were ever recorded — which is why the
    // error rate was not merely unmeasured but unmeasurable.
    ok = false;
    error = String(err?.message ?? err).slice(0, 500);
    throw err;
  } finally {
    try {
      await audit(c, v, name, args, {
        resultCount: resultCount(result),
        durationMs: Date.now() - started,
        ok,
        error,
        route: typeof result.route === "string" ? result.route : undefined,
        executor: typeof result.executor === "string" ? result.executor : undefined,
        traceId,
      });
      if (ok && typeof parsed.data.query === "string") {
        await recordRetrieval(c, v, traceId, parsed.data.query, result);
      }
    } catch (auditErr: any) {
      // Never let bookkeeping mask the caller's outcome.
      console.error(`audit skipped: ${auditErr.message}`);
    }
    if (ownsClient) await c.end();
  }
}
