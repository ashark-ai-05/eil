"""search_code v0: Bitbucket DC built-in code search behind the MCP contract.

Zero new infra and Bitbucket enforces its own repo permissions natively —
with a personal PAT you search exactly what you can read. Known limits (no
regex, 9 expressions / 250 chars, files > 512 KiB skipped) are instrumented
via the audit log so real failure data schedules the Zoekt v1 decision. The
REST endpoint is internal/unsupported (BSERV-11632): wrapped defensively.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

QUERY_MAX_CHARS = 250


class BitbucketSearchClient:
    def __init__(self, base_url: str | None = None, token: str | None = None) -> None:
        self.base_url = (base_url or os.environ["EIL_BITBUCKET_URL"]).rstrip("/")
        token = token or os.environ["EIL_BITBUCKET_TOKEN"]
        self.http = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )

    def search_code(self, query: str, limit: int = 10) -> dict[str, Any]:
        if len(query) > QUERY_MAX_CHARS:
            return {"error": f"query exceeds Bitbucket's {QUERY_MAX_CHARS}-char limit", "results": []}
        resp = self.http.post(
            "/rest/search/latest/search",
            json={
                "query": query,
                "entities": {"code": {}},
                "limits": {"primary": limit},
            },
        )
        resp.raise_for_status()
        data = resp.json()
        code = data.get("code", {})
        results = []
        for hit in code.get("values", []):
            repo = hit.get("repository", {})
            lines = [
                {"line": ctx.get("line"), "text": ctx.get("text", "")}
                for group in hit.get("hitContexts", [])
                for ctx in group
            ]
            results.append(
                {
                    "repo": f"{repo.get('project', {}).get('key', '?')}/{repo.get('slug', '?')}",
                    "path": hit.get("file", ""),
                    "lines": lines[:6],  # keep tool output compact
                }
            )
        return {"query": query, "count": code.get("count", len(results)), "results": results}
