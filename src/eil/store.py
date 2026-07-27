"""Catalog writes with the hash gate: unchanged content is a no-op.

This is what makes ingestion idempotent — re-running a connector against an
unchanged corpus writes nothing and (later) embeds nothing.
"""

from __future__ import annotations

import json

import psycopg

from eil.chunker import chunk
from eil.models import CanonicalDoc


def upsert_document(conn: psycopg.Connection, doc: CanonicalDoc) -> bool:
    """Insert or update a document and its chunks/links. Returns True if content changed."""
    row = conn.execute(
        "SELECT content_hash FROM documents WHERE id = %s", (doc.id,)
    ).fetchone()
    if row and row[0] == doc.content_hash:
        return False  # hash gate: nothing to do

    conn.execute(
        """
        INSERT INTO documents
            (id, tenant, source, title, url, author, created_at, updated_at,
             hierarchy, acl_groups, quality_tier, content_hash, body)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title, url = EXCLUDED.url, author = EXCLUDED.author,
            created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
            hierarchy = EXCLUDED.hierarchy, acl_groups = EXCLUDED.acl_groups,
            quality_tier = EXCLUDED.quality_tier, content_hash = EXCLUDED.content_hash,
            body = EXCLUDED.body, ingested_at = now()
        """,
        (
            doc.id, doc.tenant, doc.source, doc.title, doc.url, doc.author,
            doc.created_at, doc.updated_at, json.dumps(doc.hierarchy),
            json.dumps(doc.acl_groups), doc.quality_tier, doc.content_hash, doc.body,
        ),
    )
    conn.execute("DELETE FROM chunks WHERE doc_id = %s", (doc.id,))
    for c in chunk(doc):
        conn.execute(
            "INSERT INTO chunks (doc_id, seq, heading_path, text, content_hash)"
            " VALUES (%s, %s, %s, %s, %s)",
            (c.doc_id, c.seq, c.heading_path, c.text, c.content_hash),
        )
    conn.execute("DELETE FROM links WHERE src_id = %s", (doc.id,))
    for dst in doc.links:
        conn.execute(
            "INSERT INTO links (src_id, dst_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (doc.id, dst),
        )
    return True
