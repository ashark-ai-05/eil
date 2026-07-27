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
