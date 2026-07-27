"""Shared HTTP client factory for Atlassian DC connectors.

Default auth: Personal Access Token as a Bearer header — the native DC PAT
mechanism (Jira 8.14+, Confluence 7.9+, Bitbucket/Stash 5.5+ "HTTP access
tokens", Bamboo 8.0+). If EIL_<PREFIX>_USER is set, Basic auth is used
instead (user + token/password) for instances predating PAT support.

Local-mode rule: these are YOUR credentials — a PAT inherits your
permissions, so you can only ingest what you can already read. Read-only
scoped tokens are recommended where the product supports scoping (Bitbucket).
"""

from __future__ import annotations

import os

import httpx


def make_client(prefix: str, base_url: str | None = None, token: str | None = None) -> httpx.Client:
    """prefix e.g. 'CONFLUENCE' -> reads EIL_CONFLUENCE_URL/TOKEN[/USER]."""
    base_url = (base_url or os.environ[f"EIL_{prefix}_URL"]).rstrip("/")
    token = token or os.environ[f"EIL_{prefix}_TOKEN"]
    user = os.environ.get(f"EIL_{prefix}_USER")
    if user:
        return httpx.Client(base_url=base_url, auth=(user, token), timeout=30)
    return httpx.Client(
        base_url=base_url, headers={"Authorization": f"Bearer {token}"}, timeout=30
    )
