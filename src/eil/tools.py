"""Framework-agnostic tool registry — the portability seam.

The EIL tool surface is defined ONCE here as plain data (name, description,
JSON-schema parameters) plus a handler callable. Nothing in this module
depends on an MCP framework.

Hosts mount the registry however they like:
  - mcp_server.py wraps it in FastMCP for stdio (this machine).
  - A work-side MCP connector that does its own tool discovery/routing reads
    REGISTRY for specs and dispatches through call_tool() — porting is a new
    mount, zero changes to tool logic.
  - The CLI debug commands call call_tool() directly.

call_tool() is the single choke point: env gating, DB session, ACL viewer,
and audit logging all happen here, so every host gets identical behavior.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import psycopg

from eil import db, search
from eil.search import Viewer


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema for arguments
    handler: Callable[[psycopg.Connection, Viewer, dict[str, Any]], dict[str, Any] | None]
    requires_env: tuple[str, ...] = field(default_factory=tuple)


def _search_docs(conn, viewer, args):
    return search.search_docs(conn, viewer, args["query"], int(args.get("limit", 8)))


def _get_doc(conn, viewer, args):
    result = search.get_doc(conn, viewer, args["id"], int(args.get("section", 0)))
    return result or {"error": f"not found: {args['id']}"}


def _expand(conn, viewer, args):
    return search.expand(conn, viewer, args["id"])


def _search_code(conn, viewer, args):
    from eil.connectors.bitbucket import BitbucketSearchClient

    return BitbucketSearchClient().search_code(args["query"], int(args.get("limit", 10)))


def _fetch_logs(conn, viewer, args):
    from eil.connectors.elk import ElkClient

    return ElkClient().fetch_logs(
        args["query"],
        args.get("index") or None,
        int(args.get("minutes", 60)),
        int(args.get("limit", 20)),
    )


def _params(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required}


REGISTRY: dict[str, ToolSpec] = {
    spec.name: spec
    for spec in [
        ToolSpec(
            "search_docs",
            "Search indexed org knowledge (Confluence, Jira, notes). Returns compact "
            "results: ids, titles, snippets. Use get_doc(id) for full content. Ticket "
            "keys (e.g. PAY-981) resolve directly with their linked context.",
            _params(
                {"query": {"type": "string"}, "limit": {"type": "integer", "default": 8}},
                ["query"],
            ),
            _search_docs,
        ),
        ToolSpec(
            "get_doc",
            "Fetch one document's content by canonical id (from search_docs/expand). "
            "Large documents are windowed; pass section=1,2,... for more.",
            _params(
                {"id": {"type": "string"}, "section": {"type": "integer", "default": 0}},
                ["id"],
            ),
            _get_doc,
        ),
        ToolSpec(
            "expand",
            "Link-graph neighborhood of a document: tickets, pages, and notes that "
            "reference or are referenced by it. Zero-cost related context.",
            _params({"id": {"type": "string"}}, ["id"]),
            _expand,
        ),
        ToolSpec(
            "search_code",
            "Search source code across Bitbucket repositories. Exact terms work best "
            "(no regex). Returns repo, path, and matching lines.",
            _params(
                {"query": {"type": "string"}, "limit": {"type": "integer", "default": 10}},
                ["query"],
            ),
            _search_code,
            requires_env=("EIL_BITBUCKET_URL", "EIL_BITBUCKET_TOKEN"),
        ),
        ToolSpec(
            "fetch_logs",
            "Query production logs live from the logging ELK (never indexed here). "
            "Lucene query_string syntax; recency-sorted, hard-capped.",
            _params(
                {
                    "query": {"type": "string"},
                    "minutes": {"type": "integer", "default": 60},
                    "limit": {"type": "integer", "default": 20},
                    "index": {"type": "string", "default": ""},
                },
                ["query"],
            ),
            _fetch_logs,
            requires_env=("EIL_ELK_URL", "EIL_ELK_TOKEN"),
        ),
    ]
}


def _result_count(result: dict[str, Any] | None) -> int:
    if not isinstance(result, dict):
        return 0
    if "results" in result:
        return len(result["results"])
    if "edges" in result:
        return len(result["edges"])
    if "entity" in result:
        return (1 if result["entity"] else 0) + len(result.get("linked", []))
    return 1 if not result.get("error") else 0


def call_tool(
    name: str,
    args: dict[str, Any],
    viewer: Viewer | None = None,
    conn: psycopg.Connection | None = None,
) -> dict[str, Any]:
    """Dispatch a tool call with env gating, ACL viewer, and audit logging."""
    import os

    spec = REGISTRY.get(name)
    if spec is None:
        return {"error": f"unknown tool: {name}", "tools": sorted(REGISTRY)}
    missing = [e for e in spec.requires_env if not os.environ.get(e)]
    if missing:
        return {"error": f"{name} not configured: set {' and '.join(missing)}"}
    viewer = viewer or Viewer.local()
    owns_conn = conn is None
    conn = conn or db.connect()
    try:
        result = spec.handler(conn, viewer, args) or {}
        search.audit(conn, viewer.principal, name, args, _result_count(result))
        conn.commit()
        return result
    finally:
        if owns_conn:
            conn.close()
