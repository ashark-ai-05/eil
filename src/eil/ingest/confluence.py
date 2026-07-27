"""Confluence normalizer.

Phase 0 ingests fixture JSON (exported page dicts with a markdown body).
The live-API connector — CQL cursor polling with personal credentials, and
storage-format -> markdown conversion — lands in phase 1; the normalizer
contract here stays the same.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from eil.ingest.common import extract_links
from eil.models import CanonicalDoc


def normalize(page: dict[str, Any], tenant: str = "default") -> CanonicalDoc:
    doc_id = f"confluence:page:{page['id']}"
    body = page["body"]
    return CanonicalDoc(
        id=doc_id,
        tenant=tenant,
        source="confluence",
        title=page["title"],
        url=page.get("url"),
        author=page.get("author"),
        created_at=_ts(page.get("created")),
        updated_at=_ts(page.get("updated")),
        hierarchy=page.get("ancestors", []),
        acl_groups=page.get("acl_groups", []),
        quality_tier="authored",
        body=body,
        links=extract_links(body, doc_id),
    )


def _ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None
