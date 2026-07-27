"""Metrics-view verification: seed facts in deterministic loops, recompute
every expected aggregate independently in Python, assert the SQL views agree.
The view definitions (migrations/0005) and this recomputation are two
implementations of the same metric — they must not drift.
"""

from __future__ import annotations

import json

import psycopg
import pytest

from eil import db, evalrun

# Deterministic seed plan: (principal, tool, result_count, repetitions)
AUDIT_PLAN = [
    ("krunal", "search_docs", 3, 6),
    ("krunal", "search_docs", 0, 2),   # zero-result searches
    ("krunal", "get_doc", 1, 5),
    ("krunal", "expand", 4, 3),
    ("asha", "search_docs", 2, 4),
    ("asha", "search_code", 0, 1),
    ("asha", "get_doc", 1, 2),
]
DAYS = ["2026-07-25", "2026-07-26"]

LLM_PLAN = [  # (provider, model, caller, prompt, completion, latency, ok, reps)
    ("maas", "nemotron", "pr-review", 900, 120, 800, True, 4),
    ("maas", "nemotron", "pr-review", 900, 0, 100, False, 1),
    ("amp", "", "incident-triage", None, None, 30_000, True, 2),
]


@pytest.fixture(scope="module")
def conn():
    base = db.dsn()
    admin = psycopg.conninfo.make_conninfo(base, dbname="postgres")
    try:
        with psycopg.connect(admin, autocommit=True) as admin_conn:
            admin_conn.execute("DROP DATABASE IF EXISTS eil_test_metrics")
            admin_conn.execute("CREATE DATABASE eil_test_metrics")
    except psycopg.OperationalError:
        pytest.skip("postgres unavailable")
    test_dsn = psycopg.conninfo.make_conninfo(base, dbname="eil_test_metrics")
    with psycopg.connect(test_dsn) as c:
        for path in sorted(db.MIGRATIONS_DIR.glob("*.sql")):
            c.execute(path.read_text(encoding="utf-8"))
        _seed(c)
        c.commit()
        yield c
    with psycopg.connect(admin, autocommit=True) as admin_conn:
        admin_conn.execute("DROP DATABASE eil_test_metrics WITH (FORCE)")


def _seed(c) -> None:
    for day in DAYS:
        for principal, tool, result_count, reps in AUDIT_PLAN:
            for i in range(reps):
                c.execute(
                    "INSERT INTO audit_log (at, principal, tool, args, result_count)"
                    " VALUES (%s::date + interval '1 hour' * %s, %s, %s, %s, %s)",
                    (day, i, principal, tool, json.dumps({"seed": i}), result_count),
                )
        for provider, model, caller, pt, ct, lat, ok, reps in LLM_PLAN:
            for i in range(reps):
                c.execute(
                    "INSERT INTO llm_calls (at, provider, model, caller, prompt_tokens,"
                    " completion_tokens, latency_ms, ok)"
                    " VALUES (%s::date + interval '1 minute' * %s, %s, %s, %s, %s, %s, %s, %s)",
                    (day, i, provider, model or None, caller, pt, ct, lat, ok),
                )
    c.execute("INSERT INTO sync_cursors (source, cursor) VALUES ('confluence', '2026-07-26T00:00:00')")
    evalrun.record(c, {"k": 10, "mean_recall": 0.5, "queries": [
        {"query": "q1", "recall": 0.0, "missing": ["doc:x"]},
        {"query": "q2", "recall": 1.0, "missing": []},
    ]})
    evalrun.record(c, {"k": 10, "mean_recall": 1.0, "queries": [
        {"query": "q1", "recall": 1.0, "missing": []},
        {"query": "q2", "recall": 1.0, "missing": []},
    ]})
    c.execute(
        "INSERT INTO metrics.usage_facts (day, principal, tool, source, quantity, unit, cost_usd)"
        " VALUES ('2026-07-25', 'krunal', 'amp', 'amp-admin-api', 42.5, 'credits', 21.25),"
        "        ('2026-07-25', 'asha', 'maas', 'gateway', 1.2345, 'usd', 1.2345)"
    )


def _expected_calls(day: str) -> dict[tuple[str, str], int]:
    out: dict[tuple[str, str], int] = {}
    for principal, tool, _rc, reps in AUDIT_PLAN:
        out[(principal, tool)] = out.get((principal, tool), 0) + reps
    return out


def test_vw_tool_calls_matches_independent_recount(conn):
    for day in DAYS:
        rows = conn.execute(
            "SELECT principal, tool, calls FROM metrics.vw_tool_calls WHERE day = %s", (day,)
        ).fetchall()
        got = {(p, t): c for p, t, c in rows}
        assert got == _expected_calls(day)


def test_vw_zero_results_exact_rates(conn):
    # per day: search_docs = krunal(6 ok + 2 zero) + asha(4 ok) = 12 calls, 2 zero
    #          search_code = asha 1 call, 1 zero
    rows = conn.execute(
        "SELECT tool, calls, zero_calls, zero_rate FROM metrics.vw_zero_results WHERE day = %s",
        (DAYS[0],),
    ).fetchall()
    got = {t: (c, z, float(r)) for t, c, z, r in rows}
    assert got["search_docs"] == (12, 2, round(2 / 12, 3))
    assert got["search_code"] == (1, 1, 1.0)


def test_vw_two_phase_ratio(conn):
    # searches/day = 12 + 1 = 13; fetches/day = krunal 5 + asha 2 = 7
    row = conn.execute(
        "SELECT searches, fetches, ratio FROM metrics.vw_two_phase WHERE day = %s", (DAYS[1],)
    ).fetchone()
    assert row[0] == 13 and row[1] == 7
    assert float(row[2]) == round(7 / 13, 3)


def test_vw_llm_calls_aggregates(conn):
    rows = conn.execute(
        "SELECT provider, calls, prompt_tokens, failures, avg_latency_ms"
        " FROM metrics.vw_llm_calls WHERE day = %s AND caller = 'pr-review'",
        (DAYS[0],),
    ).fetchall()
    assert len(rows) == 1
    provider, calls, prompt_tokens, failures, avg_latency = rows[0]
    assert (provider, calls, prompt_tokens, failures) == ("maas", 5, 4500, 1)
    assert avg_latency == int((800 * 4 + 100) / 5)


def test_vw_eval_trend_orders_runs(conn):
    rows = conn.execute("SELECT mean_recall, queries FROM metrics.vw_eval_trend ORDER BY at").fetchall()
    assert [float(r[0]) for r in rows] == [0.5, 1.0]
    assert all(r[1] == 2 for r in rows)
    misses = conn.execute(
        "SELECT misses FROM metrics.eval_runs ORDER BY at LIMIT 1"
    ).fetchone()[0]
    assert misses == [{"query": "q1", "missing": ["doc:x"]}]


def test_vw_connector_health_age(conn):
    row = conn.execute(
        "SELECT source, age_hours FROM metrics.vw_connector_health WHERE source = 'confluence'"
    ).fetchone()
    assert row is not None and float(row[1]) >= 0


def test_vw_spend_daily_preserves_native_units(conn):
    rows = conn.execute(
        "SELECT tool, unit, quantity, cost_usd FROM metrics.vw_spend_daily ORDER BY tool"
    ).fetchall()
    got = {t: (u, float(q), float(c)) for t, u, q, c in rows}
    assert got["amp"] == ("credits", 42.5, 21.25)  # native shape preserved, no fake tokens
    assert got["maas"] == ("usd", 1.2345, 1.2345)


def test_report_renders_from_views(conn):
    from eil import report

    data = report.collect(conn)
    html_text = report.render(data, generated_at="test")
    assert "MCP calls by tool" in html_text
    assert "<svg" in html_text  # charts rendered
    assert "search_docs" in html_text
    assert "0.5" in html_text  # eval trend values present
