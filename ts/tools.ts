/**
 * Framework-agnostic tool registry — the portability seam.
 * Defined once as zod schemas + handlers; hosts mount it however they like:
 * mcp-server.ts wraps it for stdio, the CLI calls callTool() directly, and
 * the work-side connector consumes the manifest (zod-to-json-schema) or
 * spawns the stdio server. callTool() is the single choke point: env gating,
 * DB session, ACL viewer, audit logging.
 */

import type pg from "pg";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { connect } from "./db.js";
import { type Viewer, audit, expand, getDoc, localViewer, searchDocs } from "./search.js";

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: z.ZodObject<S>;
  requiresEnv: string[];
  handler: (
    client: pg.Client,
    viewer: Viewer,
    args: Record<string, any>,
  ) => Promise<Record<string, unknown> | null>;
}

const searchDocsSpec: ToolSpec = {
  name: "search_docs",
  description:
    "Search indexed org knowledge (Confluence, Jira, notes). Returns compact " +
    "results: ids, titles, snippets. Use get_doc(id) for full content. Ticket " +
    "keys (e.g. PAY-981) resolve directly with their linked context.",
  schema: z.object({ query: z.string(), limit: z.number().int().default(8) }),
  requiresEnv: [],
  handler: (c, v, a) => searchDocs(c, v, a.query, a.limit ?? 8),
};

const getDocSpec: ToolSpec = {
  name: "get_doc",
  description:
    "Fetch one document's content by canonical id (from search_docs/expand). " +
    "Large documents are windowed; pass section=1,2,... for more.",
  schema: z.object({ id: z.string(), section: z.number().int().default(0) }),
  requiresEnv: [],
  handler: async (c, v, a) =>
    (await getDoc(c, v, a.id, a.section ?? 0)) ?? { error: `not found: ${a.id}` },
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
    "Search source code across Bitbucket repositories. Exact terms work best " +
    "(no regex). Returns repo, path, and matching lines.",
  schema: z.object({ query: z.string(), limit: z.number().int().default(10) }),
  requiresEnv: ["EIL_BITBUCKET_URL", "EIL_BITBUCKET_TOKEN"],
  handler: async (_c, _v, a) => {
    const { BitbucketSearchClient } = await import("./connectors/bitbucket.js");
    return new BitbucketSearchClient().searchCode(a.query, a.limit ?? 10);
  },
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
  [searchDocsSpec, getDocSpec, expandSpec, searchCodeSpec, fetchLogsSpec].map((s) => [s.name, s]),
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
  client?: pg.Client,
): Promise<Record<string, unknown>> {
  const spec = REGISTRY[name];
  if (!spec) return { error: `unknown tool: ${name}`, tools: Object.keys(REGISTRY).sort() };
  const missing = spec.requiresEnv.filter((e) => !process.env[e]);
  if (missing.length > 0) return { error: `${name} not configured: set ${missing.join(" and ")}` };
  const v = viewer ?? localViewer();
  const ownsClient = client === undefined;
  const c = client ?? (await connect());
  try {
    const parsed = spec.schema.parse(args);
    const result = (await spec.handler(c, v, parsed)) ?? {};
    await audit(c, v.principal, name, args, resultCount(result));
    return result;
  } finally {
    if (ownsClient) await c.end();
  }
}
