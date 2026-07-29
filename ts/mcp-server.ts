/**
 * MCP server (stdio) — a thin mount over the framework-agnostic registry
 * (tools.ts). All logic, env gating, ACLs, and audit logging live in
 * callTool(); this file only adapts specs to the MCP SDK. The work-side TS
 * connector spawns this over stdio or consumes the manifest directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localViewer } from "./search.js";
import { initTelemetry } from "./telemetry.js";
import { REGISTRY, callTool } from "./tools.js";

export async function serve(): Promise<void> {
  const server = new McpServer({ name: "eil-knowledge", version: "0.2.0" });
  await initTelemetry();
  const viewer = localViewer();

  for (const spec of Object.values(REGISTRY)) {
    server.tool(spec.name, spec.description, spec.schema.shape, async (args: any) => {
      const result = await callTool(spec.name, args, viewer);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }

  await server.connect(new StdioServerTransport());
}
