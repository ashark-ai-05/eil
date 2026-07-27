"""Jira normalizer.

Issue = one document: summary as title, description + comments as body
sections. Status/labels land in the body header for now; they move to
filterable metadata columns when filtering needs demand it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from eil.ingest.common import extract_links
from eil.models import CanonicalDoc


def normalize(issue: dict[str, Any], tenant: str = "default") -> CanonicalDoc:
    key = issue["key"]
    doc_id = f"jira:issue:{key}"
    f = issue["fields"]

    parts = [f"**Status:** {f.get('status', 'Unknown')} · **Type:** {f.get('issuetype', 'Unknown')}"]
    if f.get("description"):
        parts.append(f"## Description\n\n{f['description']}")
    for c in f.get("comments", []):
        parts.append(f"## Comment — {c.get('author', 'unknown')}\n\n{c['body']}")
    body = "\n\n".join(parts)

    return CanonicalDoc(
        id=doc_id,
        tenant=tenant,
        source="jira",
        title=f"{key}: {f['summary']}",
        url=issue.get("url"),
        author=f.get("reporter"),
        created_at=_ts(f.get("created")),
        updated_at=_ts(f.get("updated")),
        hierarchy=[f.get("project", key.split("-")[0])],
        acl_groups=f.get("acl_groups", []),
        quality_tier="authored",
        body=body,
        links=extract_links(body, doc_id),
    )


def _ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None
