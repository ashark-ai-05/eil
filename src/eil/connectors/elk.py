"""fetch_logs: live query against the hosted logging ELK.

Logs are NEVER ingested into the knowledge plane (volume, retention, cost) —
this queries them where they live, with hard caps because logs are the
classic context bomb. Env: EIL_ELK_URL, EIL_ELK_TOKEN (or EIL_ELK_USER for
basic auth), EIL_ELK_INDEX default pattern.
"""

from __future__ import annotations

import os
from typing import Any

from eil.connectors.auth import make_client

MAX_HITS = 50
MESSAGE_MAX_CHARS = 400


class ElkClient:
    def __init__(self, base_url: str | None = None, token: str | None = None) -> None:
        self.base_url = (base_url or os.environ["EIL_ELK_URL"]).rstrip("/")
        self.http = make_client("ELK", self.base_url, token)
        self.default_index = os.environ.get("EIL_ELK_INDEX", "logs-*")

    def fetch_logs(
        self, query: str, index: str | None = None, minutes: int = 60, limit: int = 20
    ) -> dict[str, Any]:
        limit = min(limit, MAX_HITS)
        resp = self.http.post(
            f"/{index or self.default_index}/_search",
            json={
                "size": limit,
                "sort": [{"@timestamp": "desc"}],
                "query": {
                    "bool": {
                        "must": [{"query_string": {"query": query}}],
                        "filter": [{"range": {"@timestamp": {"gte": f"now-{minutes}m"}}}],
                    }
                },
            },
        )
        resp.raise_for_status()
        hits = resp.json().get("hits", {})
        results = []
        for h in hits.get("hits", []):
            src = h.get("_source", {})
            results.append(
                {
                    "ts": src.get("@timestamp"),
                    "level": src.get("level") or src.get("log.level"),
                    "service": src.get("service") or src.get("kubernetes", {}).get("container", {}).get("name"),
                    "message": str(src.get("message", ""))[:MESSAGE_MAX_CHARS],
                }
            )
        total = hits.get("total", {})
        return {
            "query": query,
            "window_minutes": minutes,
            "total": total.get("value", len(results)) if isinstance(total, dict) else total,
            "results": results,
        }
