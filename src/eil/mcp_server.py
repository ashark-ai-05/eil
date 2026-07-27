"""MCP server (stdio) — the knowledge plane's only door for agents.

Local mode: identity is the OS user, transport is stdio; after promotion to
kube this same server runs over HTTP with per-user tokens from the
token-issuer. Tool contracts do not change across that move.
"""

from __future__ import annotations

import getpass
import json

from mcp.server.fastmcp import FastMCP

from eil import db, search

mcp = FastMCP("eil-knowledge")
_PRINCIPAL = getpass.getuser()


def _run(tool: str, args: dict, fn) -> str:
    with db.connect() as conn:
        result = fn(conn)
        count = len(result.get("results", result.get("edges", []))) if isinstance(result, dict) else 0
        search.audit(conn, _PRINCIPAL, tool, args, count)
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def search_docs(query: str, limit: int = 8) -> str:
    """Search indexed org knowledge (Confluence, Jira, notes). Returns compact
    results: ids, titles, snippets. Use get_doc(id) to read a full document.
    Ticket keys (e.g. PAY-981) are resolved directly with their linked context."""
    return _run("search_docs", {"query": query}, lambda c: search.search_docs(c, query, limit))


@mcp.tool()
def get_doc(id: str, section: int = 0) -> str:
    """Fetch one document's content by canonical id (from search_docs/expand
    results). Large documents are windowed; pass section=1,2,... for more."""
    return _run(
        "get_doc", {"id": id, "section": section},
        lambda c: search.get_doc(c, id, section) or {"error": f"not found: {id}"},
    )


@mcp.tool()
def expand(id: str) -> str:
    """Link-graph neighborhood of a document: tickets, pages, and notes that
    reference or are referenced by it. Zero-cost way to gather related context."""
    return _run("expand", {"id": id}, lambda c: search.expand(c, id))


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
