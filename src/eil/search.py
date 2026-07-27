"""Query execution: router -> executors -> fusion. The deterministic query path.

Every tool result is compact by design (ids + snippets, capped sizes) — the
two-phase retrieval contract that keeps agent context lean.
"""

from __future__ import annotations

import getpass
import json
import os
from dataclasses import dataclass, field
from typing import Any

import psycopg

from eil import ranking
from eil.fusion import rrf
from eil.router import Route, classify

SNIPPET_OPTS = "StartSel=**, StopSel=**, MaxWords=40, MinWords=10"
GET_DOC_MAX_CHARS = 8_000
EXPAND_MAX_EDGES = 50

# Mandatory, fail-closed: a doc is visible iff the viewer ingested it (personal
# credentials mean they could read it at the source) or shares a group with its
# acl_groups stamps. Injected server-side into every read — never caller-controlled.
ACL_SQL = "(d.ingested_by = %(principal)s OR d.acl_groups ?| %(groups)s)"


@dataclass(frozen=True)
class Viewer:
    principal: str
    groups: list[str] = field(default_factory=list)

    @classmethod
    def local(cls) -> Viewer:
        """Local mode: OS user + optional EIL_USER_GROUPS (comma-separated).
        On kube this is built from the per-user token's claims instead."""
        raw = os.environ.get("EIL_USER_GROUPS", "")
        return cls(getpass.getuser(), [g.strip() for g in raw.split(",") if g.strip()])

    def params(self) -> dict[str, Any]:
        return {"principal": self.principal, "groups": self.groups}


def search_docs(
    conn: psycopg.Connection, viewer: Viewer, query: str, limit: int = 8
) -> dict[str, Any]:
    decision = classify(query)

    if decision.route == Route.ENTITY:
        entity_id = f"jira:issue:{decision.match}"
        doc = get_doc(conn, viewer, entity_id, max_chars=2_000)
        neighborhood = expand(conn, viewer, entity_id)
        return {"route": decision.route.value, "entity": doc, "linked": neighborhood["edges"]}

    # v0: single lexical arm through Postgres FTS; kNN arm joins here later and
    # rrf() already fuses however many arms exist.
    rows = conn.execute(
        f"""
        SELECT c.doc_id, d.title, d.url, d.quality_tier, d.updated_at,
               ts_rank(c.tsv, websearch_to_tsquery('english', %(q)s)) AS rank,
               ts_headline('english', c.text,
                           websearch_to_tsquery('english', %(q)s), %(opts)s) AS snippet
        FROM chunks c JOIN documents d ON d.id = c.doc_id
        WHERE c.tsv @@ websearch_to_tsquery('english', %(q)s) AND {ACL_SQL}
        ORDER BY rank DESC, c.doc_id, c.seq
        LIMIT %(limit)s
        """,
        {"q": query, "opts": SNIPPET_OPTS, "limit": limit * 3, **viewer.params()},
    ).fetchall()

    by_doc: dict[str, dict[str, Any]] = {}
    for doc_id, title, url, tier, updated_at, _rank, snippet in rows:
        by_doc.setdefault(
            doc_id,
            {"id": doc_id, "title": title, "url": url, "tier": tier,
             "snippet": snippet, "_updated": updated_at},
        )
    fused = rrf({"fts": list(by_doc)})
    scored = sorted(
        (
            (score * ranking.modifier(by_doc[doc_id]["tier"], by_doc[doc_id]["_updated"]), doc_id)
            for doc_id, score in fused
        ),
        key=lambda pair: (-pair[0], pair[1]),
    )
    results = []
    for score, doc_id in scored[:limit]:
        entry = {k: v for k, v in by_doc[doc_id].items() if k != "_updated"}
        entry["score"] = round(score, 6)
        results.append(entry)
    return {"route": decision.route.value, "results": results}


def get_doc(
    conn: psycopg.Connection,
    viewer: Viewer,
    doc_id: str,
    section: int = 0,
    max_chars: int = GET_DOC_MAX_CHARS,
) -> dict[str, Any] | None:
    row = conn.execute(
        f"SELECT id, title, url, source, quality_tier, hierarchy, updated_at, body"
        f" FROM documents d WHERE id = %(id)s AND {ACL_SQL}",
        {"id": doc_id, **viewer.params()},
    ).fetchone()
    if not row:
        return None
    body: str = row[7]
    start = section * max_chars
    window = body[start : start + max_chars]
    return {
        "id": row[0],
        "title": row[1],
        "url": row[2],
        "source": row[3],
        "tier": row[4],
        "hierarchy": json.loads(row[5]) if isinstance(row[5], str) else row[5],
        "updated_at": row[6].isoformat() if row[6] else None,
        "section": section,
        "total_sections": max(1, -(-len(body) // max_chars)),
        "body": window,
    }


def expand(
    conn: psycopg.Connection, viewer: Viewer, doc_id: str, limit: int = EXPAND_MAX_EDGES
) -> dict[str, Any]:
    # Fail-closed on the FOCAL document first: expanding a restricted doc must
    # leak nothing — not even the ids its body references (dangling out-edges
    # would otherwise slip past the destination-side ACL check below).
    restricted = conn.execute(
        f"SELECT 1 FROM documents d WHERE d.id = %(id)s AND NOT {ACL_SQL}",
        {"id": doc_id, **viewer.params()},
    ).fetchone()
    if restricted:
        return {"id": doc_id, "edges": [], "truncated": False}

    # Destination-side visibility is fail-closed too: edges to ingested-but-
    # unreadable docs are dropped. Dangling edges (doc not ingested) survive —
    # the focal doc is readable, so its extracted ids are fair game.
    # Per-arm LIMITs: a single trailing LIMIT after UNION ALL would let a hub
    # doc's in-edges starve out its out-edges ('in' sorts before 'out').
    rows = conn.execute(
        f"""
        (SELECT l.dst_id AS other, l.rel, 'out' AS direction, d.title
         FROM links l LEFT JOIN documents d ON d.id = l.dst_id
         WHERE l.src_id = %(id)s AND (d.id IS NULL OR {ACL_SQL})
         ORDER BY other LIMIT %(limit)s)
        UNION ALL
        (SELECT l.src_id AS other, l.rel, 'in' AS direction, d.title
         FROM links l LEFT JOIN documents d ON d.id = l.src_id
         WHERE l.dst_id = %(id)s AND (d.id IS NULL OR {ACL_SQL})
         ORDER BY other LIMIT %(limit)s)
        ORDER BY direction, other
        """,
        {"id": doc_id, "limit": limit, **viewer.params()},
    ).fetchall()
    edges = [
        {"id": other, "rel": rel, "direction": direction, "title": title, "ingested": title is not None}
        for other, rel, direction, title in rows
    ]
    per_arm = {d: sum(1 for e in edges if e["direction"] == d) for d in ("in", "out")}
    return {"id": doc_id, "edges": edges, "truncated": max(per_arm.values()) >= limit}


def audit(conn: psycopg.Connection, principal: str, tool: str, args: dict, count: int) -> None:
    conn.execute(
        "INSERT INTO audit_log (principal, tool, args, result_count) VALUES (%s, %s, %s, %s)",
        (principal, tool, json.dumps(args), count),
    )
