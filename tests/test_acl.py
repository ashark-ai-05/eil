"""Red-team ACL suite — the phase-2 rollout gate.

Plants documents a viewer must NOT see and asserts they never surface through
any read path (search, fetch, link expansion). Runs against a dedicated
eil_test database; skipped when Postgres is unreachable (pure-function tests
still run). CI always runs it.
"""

from __future__ import annotations

import getpass

import psycopg
import pytest

from eil import db
from eil.models import CanonicalDoc
from eil.search import Viewer, expand, get_doc, search_docs
from eil.store import upsert_document

ME = getpass.getuser()


@pytest.fixture(scope="module")
def conn():
    base = db.dsn()
    admin = psycopg.conninfo.make_conninfo(base, dbname="postgres")
    try:
        with psycopg.connect(admin, autocommit=True) as admin_conn:
            admin_conn.execute("DROP DATABASE IF EXISTS eil_test")
            admin_conn.execute("CREATE DATABASE eil_test")
    except psycopg.OperationalError:
        pytest.skip("postgres unavailable")
    test_dsn = psycopg.conninfo.make_conninfo(base, dbname="eil_test")
    with psycopg.connect(test_dsn) as c:
        for path in sorted(db.MIGRATIONS_DIR.glob("*.sql")):
            c.execute(path.read_text(encoding="utf-8"))
        _seed(c)
        c.commit()
        yield c
    with psycopg.connect(admin, autocommit=True) as admin_conn:
        admin_conn.execute("DROP DATABASE eil_test WITH (FORCE)")


def _doc(doc_id: str, title: str, body: str, acl: list[str]) -> CanonicalDoc:
    return CanonicalDoc(
        id=doc_id, source="confluence", title=title, body=body, acl_groups=acl,
        links=["jira:issue:SEC-1"] if "secret" in doc_id else [],
    )


def _seed(conn) -> None:
    upsert_document(conn, _doc("confluence:page:open", "Public Runbook",
                               "zebra deployment guide for everyone", []))
    upsert_document(conn, _doc("confluence:page:secret", "Merger Plans",
                               "zebra deployment guide for insiders only", ["grp-secret"]))
    upsert_document(conn, _doc("jira:issue:SEC-1", "SEC-1 secret ticket",
                               "restricted zebra work", ["grp-secret"]))
    # The planted docs were ingested by someone else — the red-team premise.
    conn.execute(
        "UPDATE documents SET ingested_by = 'mallory-ingester'"
        " WHERE id IN ('confluence:page:secret', 'jira:issue:SEC-1')"
    )


OUTSIDER = Viewer(ME, groups=["grp-payments"])
INSIDER = Viewer(ME, groups=["grp-secret"])


def test_restricted_doc_never_surfaces_in_search(conn):
    results = search_docs(conn, OUTSIDER, "zebra deployment guide")["results"]
    ids = [r["id"] for r in results]
    assert "confluence:page:open" in ids
    assert "confluence:page:secret" not in ids


def test_restricted_doc_not_fetchable(conn):
    assert get_doc(conn, OUTSIDER, "confluence:page:secret") is None


def test_entity_route_respects_acl(conn):
    result = search_docs(conn, OUTSIDER, "SEC-1")
    assert result["entity"] is None


def test_expand_drops_edges_to_restricted_docs(conn):
    edges = expand(conn, OUTSIDER, "confluence:page:secret")["edges"]
    assert edges == []  # even the neighborhood of a restricted doc yields nothing readable
    # and from the readable side: SEC-1 is ingested+restricted, so it must not appear
    upsert_document(conn, _doc("confluence:page:linker", "Linker", "mentions SEC-1", []))
    edges = expand(conn, OUTSIDER, "confluence:page:linker")["edges"]
    assert all(e["id"] != "jira:issue:SEC-1" for e in edges)


def test_group_membership_grants_access(conn):
    assert get_doc(conn, INSIDER, "confluence:page:secret") is not None
    ids = [r["id"] for r in search_docs(conn, INSIDER, "zebra deployment guide")["results"]]
    assert "confluence:page:secret" in ids


def test_ingester_always_sees_own_documents(conn):
    # ME ingested the open doc (personal-credentials rule)
    assert get_doc(conn, Viewer(ME, groups=[]), "confluence:page:open") is not None


def test_empty_acl_is_fail_closed_for_others(conn):
    stranger = Viewer("someone-else", groups=["grp-payments"])
    assert get_doc(conn, stranger, "confluence:page:open") is None


def test_expanding_restricted_doc_leaks_nothing_not_even_dangling_edges(conn):
    """The reviewer-found leak: a restricted doc's body references dangling ids;
    those ids must not surface for an outsider expanding the restricted doc."""
    doc = _doc("confluence:page:secret-linky", "Secret Linky",
               "restricted content", ["grp-secret"])
    doc = doc.model_copy(update={"links": ["jira:issue:HID-9"]})  # dangling target
    upsert_document(conn, doc)
    conn.execute(
        "UPDATE documents SET ingested_by = 'mallory-ingester'"
        " WHERE id = 'confluence:page:secret-linky'"
    )
    result = expand(conn, OUTSIDER, "confluence:page:secret-linky")
    assert result["edges"] == []  # not even jira:issue:HID-9
    insider = expand(conn, INSIDER, "confluence:page:secret-linky")
    assert any(e["id"] == "jira:issue:HID-9" for e in insider["edges"])


def test_entity_route_linked_is_empty_for_restricted_entity(conn):
    result = search_docs(conn, OUTSIDER, "SEC-1")
    assert result["entity"] is None
    assert result["linked"] == []


def test_expand_out_edges_not_starved_by_in_edges(conn):
    """'in' sorts before 'out'; per-arm limits must keep out-edges visible on
    hub documents, and truncation must be reported."""
    hub = _doc("confluence:page:hub", "Hub", "the hub", [])
    hub = hub.model_copy(update={"links": ["jira:issue:OUT-1"]})
    upsert_document(conn, hub)
    for n in range(3):
        spoke = _doc(f"confluence:page:spoke{n}", f"Spoke {n}", "spoke", [])
        spoke = spoke.model_copy(update={"links": ["confluence:page:hub"]})
        upsert_document(conn, spoke)
    result = expand(conn, Viewer(ME), "confluence:page:hub", limit=2)
    directions = {e["direction"] for e in result["edges"]}
    assert "out" in directions  # the out-edge survives despite 3 in-edges and limit=2
    assert result["truncated"] is True  # in-arm hit its limit
    full = expand(conn, Viewer(ME), "confluence:page:hub", limit=50)
    assert full["truncated"] is False
    assert sum(1 for e in full["edges"] if e["direction"] == "in") == 3


def test_reingest_heals_empty_ingested_by(conn):
    """Pre-0003 rows (ingested_by='') are invisible but repairable: the hash
    gate must not block re-ingest of unchanged content in that state."""
    doc = _doc("confluence:page:legacy", "Legacy", "legacy content here", [])
    upsert_document(conn, doc)
    conn.execute("UPDATE documents SET ingested_by = '' WHERE id = 'confluence:page:legacy'")
    assert get_doc(conn, Viewer(ME), "confluence:page:legacy") is None  # invisible
    assert upsert_document(conn, doc) is True  # gate bypassed, not a no-op
    assert get_doc(conn, Viewer(ME), "confluence:page:legacy") is not None  # healed


def test_deleting_document_cascades_its_link_edges(conn):
    doc = _doc("confluence:page:doomed", "Doomed", "references DOOM-1", [])
    doc = doc.model_copy(update={"links": ["jira:issue:DOOM-1"]})
    upsert_document(conn, doc)
    count = conn.execute(
        "SELECT count(*) FROM links WHERE src_id = 'confluence:page:doomed'"
    ).fetchone()[0]
    assert count == 1
    conn.execute("DELETE FROM documents WHERE id = 'confluence:page:doomed'")
    count = conn.execute(
        "SELECT count(*) FROM links WHERE src_id = 'confluence:page:doomed'"
    ).fetchone()[0]
    assert count == 0  # links_src_fk cascade
