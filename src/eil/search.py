"""Query execution: router -> executors -> fusion. The deterministic query path.

Every tool result is compact by design (ids + snippets, capped sizes) — the
two-phase retrieval contract that keeps agent context lean.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg

from eil.fusion import rrf
from eil.router import Route, classify

SNIPPET_OPTS = "StartSel=**, StopSel=**, MaxWords=40, MinWords=10"
GET_DOC_MAX_CHARS = 8_000
EXPAND_MAX_EDGES = 50


def search_docs(conn: psycopg.Connection, query: str, limit: int = 8) -> dict[str, Any]:
    decision = classify(query)

    if decision.route == Route.ENTITY:
        entity_id = f"jira:issue:{decision.match}"
        doc = get_doc(conn, entity_id, max_chars=2_000)
        neighborhood = expand(conn, entity_id)
        return {"route": decision.route.value, "entity": doc, "linked": neighborhood["edges"]}

    # v0: single lexical arm through Postgres FTS; kNN arm joins here later and
    # rrf() already fuses however many arms exist.
    rows = conn.execute(
        """
        SELECT c.doc_id, d.title, d.url, d.quality_tier,
               ts_rank(c.tsv, websearch_to_tsquery('english', %(q)s)) AS rank,
               ts_headline('english', c.text,
                           websearch_to_tsquery('english', %(q)s), %(opts)s) AS snippet
        FROM chunks c JOIN documents d ON d.id = c.doc_id
        WHERE c.tsv @@ websearch_to_tsquery('english', %(q)s)
        ORDER BY rank DESC, c.doc_id, c.seq
        LIMIT %(limit)s
        """,
        {"q": query, "opts": SNIPPET_OPTS, "limit": limit * 3},
    ).fetchall()

    by_doc: dict[str, dict[str, Any]] = {}
    for doc_id, title, url, tier, _rank, snippet in rows:
        by_doc.setdefault(
            doc_id, {"id": doc_id, "title": title, "url": url, "tier": tier, "snippet": snippet}
        )
    fused = rrf({"fts": list(by_doc)})
    results = [by_doc[doc_id] for doc_id, _score in fused[:limit]]
    return {"route": decision.route.value, "results": results}


def get_doc(
    conn: psycopg.Connection, doc_id: str, section: int = 0, max_chars: int = GET_DOC_MAX_CHARS
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT id, title, url, source, quality_tier, hierarchy, updated_at, body"
        " FROM documents WHERE id = %s",
        (doc_id,),
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


def expand(conn: psycopg.Connection, doc_id: str, limit: int = EXPAND_MAX_EDGES) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT l.dst_id AS other, l.rel, 'out' AS direction, d.title
        FROM links l LEFT JOIN documents d ON d.id = l.dst_id
        WHERE l.src_id = %(id)s
        UNION ALL
        SELECT l.src_id AS other, l.rel, 'in' AS direction, d.title
        FROM links l LEFT JOIN documents d ON d.id = l.src_id
        WHERE l.dst_id = %(id)s
        ORDER BY direction, other
        LIMIT %(limit)s
        """,
        {"id": doc_id, "limit": limit},
    ).fetchall()
    edges = [
        {"id": other, "rel": rel, "direction": direction, "title": title, "ingested": title is not None}
        for other, rel, direction, title in rows
    ]
    return {"id": doc_id, "edges": edges}


def audit(conn: psycopg.Connection, principal: str, tool: str, args: dict, count: int) -> None:
    conn.execute(
        "INSERT INTO audit_log (principal, tool, args, result_count) VALUES (%s, %s, %s, %s)",
        (principal, tool, json.dumps(args), count),
    )
