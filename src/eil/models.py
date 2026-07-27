"""Canonical document model — the shape every connector normalizes into.

Every source (Confluence, Jira, Bitbucket, transcripts, Obsidian) becomes a
CanonicalDoc before touching an index. Reuse across sources and teams falls
out of this single shape.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

from pydantic import BaseModel, Field

QUALITY_TIERS = ("curated", "authored", "generated", "raw")


class CanonicalDoc(BaseModel):
    id: str  # "confluence:page:12345" | "jira:issue:PAY-981" | "obsidian:note:path"
    tenant: str = "default"
    source: str  # confluence | jira | bitbucket | transcript | obsidian
    title: str
    url: str | None = None
    author: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    hierarchy: list[str] = Field(default_factory=list)
    acl_groups: list[str] = Field(default_factory=list)  # empty = fail-closed (owner-only)
    quality_tier: str = "authored"
    body: str  # markdown, always

    links: list[str] = Field(default_factory=list)  # canonical ids this doc references

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.body.encode("utf-8")).hexdigest()


class Chunk(BaseModel):
    doc_id: str
    seq: int
    heading_path: str  # breadcrumb, e.g. "Payments > Runbooks > Retry Policy"
    text: str  # breadcrumb-prefixed — a chunk is self-describing in isolation

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()
