"""Live Jira DC connector: cursor-based JQL incremental sync.

Same contract rule as Confluence: output is the issue dict the fixture path
uses, so eil.ingest.jira.normalize is the interface either way. Personal PAT
via EIL_JIRA_TOKEN in local mode.

Note: Jira DC descriptions/comments are wiki markup, not markdown — close
enough for FTS; a proper wiki->md pass can join the normalizer later without
changing this connector.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

from eil.connectors.auth import make_client
from eil.connectors.confluence import cql_ts

PAGE_SIZE = 50
FIELDS = "summary,description,status,issuetype,project,reporter,created,updated,comment"


class JiraClient:
    def __init__(self, base_url: str | None = None, token: str | None = None) -> None:
        self.base_url = (base_url or os.environ["EIL_JIRA_URL"]).rstrip("/")
        self.http = make_client("JIRA", self.base_url, token)

    def updated_since(self, cursor: str | None) -> Iterator[dict[str, Any]]:
        jql = "order by updated asc"
        if cursor:
            jql = f'updated >= "{cql_ts(cursor)}" order by updated asc'
        start = 0
        while True:
            resp = self.http.get(
                "/rest/api/2/search",
                params={"jql": jql, "fields": FIELDS, "maxResults": PAGE_SIZE, "startAt": start},
            )
            resp.raise_for_status()
            data = resp.json()
            issues = data.get("issues", [])
            for issue in issues:
                yield self.to_issue_dict(issue)
            start += len(issues)
            if start >= data.get("total", 0) or not issues:
                return

    def to_issue_dict(self, api_issue: dict[str, Any]) -> dict[str, Any]:
        f = api_issue["fields"]
        comments = [
            {"author": c.get("author", {}).get("displayName", "unknown"), "body": c.get("body", "")}
            for c in f.get("comment", {}).get("comments", [])
        ]
        return {
            "key": api_issue["key"],
            "url": f"{self.base_url}/browse/{api_issue['key']}",
            "fields": {
                "summary": f.get("summary", ""),
                "status": (f.get("status") or {}).get("name"),
                "issuetype": (f.get("issuetype") or {}).get("name"),
                "project": (f.get("project") or {}).get("key"),
                "reporter": (f.get("reporter") or {}).get("displayName"),
                "created": f.get("created"),
                "updated": f.get("updated"),
                "description": f.get("description") or "",
                "comments": comments,
                "acl_groups": [],
            },
        }
