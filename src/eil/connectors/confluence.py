"""Live Confluence DC connector: cursor-based CQL incremental sync.

Personal-credential rule (local mode): auth is YOUR PAT via
EIL_CONFLUENCE_TOKEN — you can only ingest what you can already read, which
is ACL-by-construction until the phase-2 gate exists. Service accounts are a
kube-only concept.

Output is the same page dict the fixture path uses — the normalizer contract
(eil.ingest.confluence.normalize) is the interface, live or fixture.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import httpx

from eil.connectors.htmlmd import html_to_markdown

PAGE_SIZE = 50


def cql_ts(iso_cursor: str) -> str:
    """ISO timestamp -> the 'yyyy-MM-dd HH:mm' form CQL/JQL accept."""
    return iso_cursor[:16].replace("T", " ")


class ConfluenceClient:
    def __init__(self, base_url: str | None = None, token: str | None = None) -> None:
        self.base_url = (base_url or os.environ["EIL_CONFLUENCE_URL"]).rstrip("/")
        token = token or os.environ["EIL_CONFLUENCE_TOKEN"]
        self.http = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )

    def updated_since(self, cursor: str | None) -> Iterator[dict[str, Any]]:
        """Yield page dicts for content modified since the cursor (ISO date)."""
        cql = "type=page order by lastmodified asc"
        if cursor:
            cql = f'type=page and lastmodified >= "{cql_ts(cursor)}" order by lastmodified asc'
        start = 0
        while True:
            resp = self.http.get(
                "/rest/api/content/search",
                params={
                    "cql": cql,
                    "expand": "body.storage,ancestors,version,space",
                    "limit": PAGE_SIZE,
                    "start": start,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            for page in data.get("results", []):
                yield self.to_page_dict(page)
            if data.get("size", 0) < PAGE_SIZE:
                return
            start += PAGE_SIZE

    def to_page_dict(self, api_page: dict[str, Any]) -> dict[str, Any]:
        """Map a Confluence API response item to the normalizer's page dict."""
        version = api_page.get("version", {})
        space = api_page.get("space", {}).get("name")
        ancestors = [a.get("title", "") for a in api_page.get("ancestors", [])]
        webui = api_page.get("_links", {}).get("webui", "")
        return {
            "id": api_page["id"],
            "title": api_page["title"],
            "url": f"{self.base_url}{webui}" if webui else None,
            "author": version.get("by", {}).get("displayName"),
            "updated": version.get("when"),
            "created": None,
            "ancestors": ([space] if space else []) + ancestors,
            "acl_groups": [],  # stamped by the phase-2 ACL syncer; empty = fail-closed
            "body": html_to_markdown(api_page.get("body", {}).get("storage", {}).get("value", "")),
        }
