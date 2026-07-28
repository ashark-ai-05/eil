/**
 * Framework-agnostic tool registry — the portability seam.
 * Defined once as zod schemas + handlers; hosts mount it however they like:
 * mcp-server.ts wraps it for stdio, the CLI calls callTool() directly, and
 * the work-side connector consumes the manifest (zod-to-json-schema) or
 * spawns the stdio server. callTool() is the single choke point: env gating,
 * DB session, ACL viewer, audit logging.
 */

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
  searchDocs,
} from "./search.js";

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
    "Search indexed org knowledge (Confluence, Jira, notes). Returns compact " +
    "results: ids, titles, snippets. Use get_doc(id) for full content. Ticket " +
    "keys (e.g. PAY-981) resolve directly with their linked context.",
  schema: z.object({ query: z.string(), limit: z.number().int().default(8) }),
  requiresEnv: [],
  handler: (c, v, a) => searchDocs(c, v, a.query, a.limit ?? 8),
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
    "Large documents are windowed; pass section=1,2,... for more. This read never refreshes or mutates the catalog.",
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
    const note = await freshFetch(c, v, a.id);
    if (note) return { error: note };
    const doc = await getDoc(c, v, a.id);
    return doc ? { id: a.id, status: "refreshed" } : { error: `not found after refresh: ${a.id}` };
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
  try {
    const result = (await spec.handler(c, v, parsed.data)) ?? {};
    await audit(c, v, name, args, resultCount(result));
    return result;
  } finally {
    if (ownsClient) await c.end();
  }
}
