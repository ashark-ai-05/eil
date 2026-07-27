"""Rule-based query router — no LLM interprets queries, ever.

Developer queries are heavily patterned; these rules cover the overwhelming
majority and keep the query path deterministic and free. Unmatched queries
fall through to hybrid docs search.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class Route(str, Enum):
    ENTITY = "entity"  # ticket key etc. -> catalog lookup + link-graph expand
    PATH = "path"  # file path -> code search, path-filtered
    SYMBOL = "symbol"  # identifier-shaped -> symbol DB (v1) / code search (v0)
    EXACT = "exact"  # quoted phrase or error string -> exact match
    DOCS = "docs"  # everything else -> hybrid docs search


@dataclass(frozen=True)
class Decision:
    route: Route
    match: str | None = None  # the token that triggered the rule, if any


_TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
_QUOTED_RE = re.compile(r'"([^"]{3,})"')
_PATH_RE = re.compile(r"\b(\S+/\S+\.\w{1,8}|\S+\.(?:java|py|go|ts|tsx|js|rb|kt|scala|sql))(?::\d+)?\b")
_ERRORISH_RE = re.compile(r"\b\w*(?:Exception|Error)\b")
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _identifier_shaped(q: str) -> bool:
    if not _IDENTIFIER_RE.match(q):
        return False
    has_snake = "_" in q
    has_camel = q != q.lower() and q != q.upper()
    return has_snake or has_camel


def classify(query: str) -> Decision:
    q = query.strip()
    if m := _TICKET_RE.search(q):
        return Decision(Route.ENTITY, m.group(1))
    if m := _PATH_RE.search(q):
        return Decision(Route.PATH, m.group(1))
    if m := _QUOTED_RE.search(q):
        return Decision(Route.EXACT, m.group(1))
    if m := _ERRORISH_RE.search(q):
        return Decision(Route.EXACT, m.group(0))
    if " " not in q and _identifier_shaped(q):
        return Decision(Route.SYMBOL, q)
    return Decision(Route.DOCS)
