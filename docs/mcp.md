# Using EIL from MCP

EIL exposes six tools — `search_docs`, `get_doc`, `refresh_doc`, `expand`,
`search_code`, `fetch_logs` — and is **two-phase by design**: search returns ids + snippets,
then you fetch only what matters.

There are three ways to consume it, in increasing order of coupling.

---

## 1. Run it as its own MCP server (no code)

EIL is a standard stdio MCP server. It registers next to whatever MCP servers
you already run; nothing about them changes.

**Claude Code**

```sh
claude mcp add eil-knowledge -- pnpm -s --dir /path/to/eil eil serve
```

**Amp** (`~/.config/amp/settings.json`, keeping your existing entries)

```json
{
  "amp.mcpServers": {
    "eil-knowledge": {
      "command": "pnpm",
      "args": ["-s", "--dir", "/path/to/eil", "eil", "serve"]
    }
  }
}
```

**VS Code / Copilot agent mode** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "eil-knowledge": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["-s", "--dir", "/path/to/eil", "eil", "serve"]
    }
  }
}
```

Env vars (`EIL_DATABASE_URL`, `EIL_*_TOKEN`, ...) can be set per-entry via the
client's `env` field if the client doesn't inherit your shell environment.

---

## 2. Mount EIL's tools inside your own TypeScript MCP server

If you already run your own `McpServer` and want EIL's tools to appear on it
rather than as a second server, mount the registry. This is the whole
integration:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REGISTRY, callTool } from "eil/tools";
import { localViewer } from "eil/search";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

// ...your own tools here...

const viewer = localViewer();
for (const spec of Object.values(REGISTRY)) {
  server.tool(spec.name, spec.description, spec.schema.shape, async (args: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await callTool(spec.name, args, viewer)) }],
  }));
}
```

`ts/mcp-server.ts` is exactly this and nothing more — it's the reference
implementation, worth reading before you write your own.

**`callTool()` is the choke point, so you inherit all of it:** required-env
gating, zod argument validation (returning a clean error dict rather than
leaking caller values through a `ZodError`), the ACL viewer, audit logging, and
DB connection lifecycle. Don't reimplement any of that around it.

### Wiring it up

Published releases contain compiled JavaScript and declarations, so plain Node can import the supported subpaths. Install a pinned release normally:

```sh
pnpm add eil@0.2.0
```

For an unpublished checkout, run `pnpm build` and consume the tarball produced by `pnpm pack`; the package smoke test verifies that exact external-install path.

### Two things that will bite you

**Identity.** `localViewer()` derives the viewer from the OS user plus
`EIL_USER_GROUPS` / `EIL_TENANT`. That is correct for stdio, where each user
spawns their own process. It is **wrong for a shared or remote server**: every
caller would inherit the server process's identity and see whatever it can see.
If your server handles more than one person, build a `Viewer` per request and
pass it in — ACL filtering is driven entirely by that argument:

```ts
await callTool(spec.name, args, { principal: user.id, groups: user.groups, tenant: user.tenant });
```

**Connections.** With no fourth argument, `callTool` opens and closes a DB
connection per call. Under any real load, pass a shared `Db`:

```ts
import { connect } from "eil/db";
const db = await connect();
await callTool(spec.name, args, viewer, db);   // caller now owns the lifecycle
```

---

## 3. Aggregate it under a router / tool-discovery connector

A routing MCP connector treats EIL as one upstream among many:

1. **Index without spawning** — `pnpm -s eil tools` emits the manifest
   (`{name, description, inputSchema, requiresEnv}` per tool, JSON Schema via
   zod-to-json-schema). Load it into the router's tool index so discovery costs
   zero processes and zero tokens.
2. **Spawn on demand** — when a call routes to an EIL tool, spawn
   `pnpm -s eil serve` as a child stdio server and proxy `tools/call`;
   `tools/list` will match the manifest.
3. **Or skip the subprocess** — mount in-process per section 2 above.

**Name collisions**: if another server already exposes a `search_docs`-style
name, rely on the client's per-server namespacing (most prefix tools with the
server name), or rename at the aggregator — EIL tool names are data in the
manifest, not protocol constants.

---

## Coexisting with live-query MCP tools

If you already run MCP servers that query Jira/Confluence/ELK live, keep them —
they answer a different question:

| Use | Tool |
|---|---|
| Find / look up / connect knowledge (cheap, indexed, ACL-filtered, ranked) | **EIL**: `search_docs`, `expand`, `search_code` |
| Fetch one indexed doc's content | **EIL**: `get_doc` (windowed) |
| Live state, writes, transitions (create ticket, add comment, current status) | your existing live MCP tools |
| Production logs | either — EIL's `fetch_logs` is the capped, audited read path |

Rules of thumb: retrieval goes through EIL (zero tokens, recency-ranked,
link-graph aware); mutations and moment-of-truth reads stay with the live
tools; and if an EIL result looks stale, `get_doc`-then-live-fetch is the
escalation path.

Your existing extractors can also become ingestion feeders — anything that
emits the normalizer input shapes (see `ts/ingest/`) can fill the catalog
without new connector code.
