"""MCP server (stdio) — a thin FastMCP mount over the framework-agnostic
tool registry (eil.tools). All logic, env gating, ACLs, and audit logging
live in tools.call_tool(); this file only adapts specs to FastMCP's typed
signature style. A different host (work-side MCP connector, HTTP transport
on kube) mounts the same registry instead of this file.
"""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from eil import tools
from eil.search import Viewer

mcp = FastMCP("eil-knowledge")
_VIEWER = Viewer.local()

_D = {name: spec.description for name, spec in tools.REGISTRY.items()}


@mcp.tool(description=_D["search_docs"])
def search_docs(query: str, limit: int = 8) -> str:
    return json.dumps(tools.call_tool("search_docs", {"query": query, "limit": limit}, _VIEWER))


@mcp.tool(description=_D["get_doc"])
def get_doc(id: str, section: int = 0) -> str:
    return json.dumps(tools.call_tool("get_doc", {"id": id, "section": section}, _VIEWER))


@mcp.tool(description=_D["expand"])
def expand(id: str) -> str:
    return json.dumps(tools.call_tool("expand", {"id": id}, _VIEWER))


@mcp.tool(description=_D["search_code"])
def search_code(query: str, limit: int = 10) -> str:
    return json.dumps(tools.call_tool("search_code", {"query": query, "limit": limit}, _VIEWER))


@mcp.tool(description=_D["fetch_logs"])
def fetch_logs(query: str, minutes: int = 60, limit: int = 20, index: str = "") -> str:
    return json.dumps(
        tools.call_tool(
            "fetch_logs", {"query": query, "minutes": minutes, "limit": limit, "index": index},
            _VIEWER,
        )
    )


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
