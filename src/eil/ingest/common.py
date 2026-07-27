"""Shared normalizer helpers: link extraction from markdown bodies."""

from __future__ import annotations

import re

_TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def extract_links(body: str, self_id: str) -> list[str]:
    """Ticket keys and [[wikilinks]] found in a body, as canonical ids."""
    links: list[str] = []
    for key in _TICKET_RE.findall(body):
        links.append(f"jira:issue:{key}")
    for target in _WIKILINK_RE.findall(body):
        links.append(f"obsidian:note:{target.strip()}")
    seen: set[str] = set()
    out = []
    for link in links:
        if link != self_id and link not in seen:
            seen.add(link)
            out.append(link)
    return out
