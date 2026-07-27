"""Postgres access + migration runner.

12-factor: the DSN comes from EIL_DATABASE_URL; nothing assumes where
Postgres lives (laptop brew service today, kube operator after promotion).
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


def dsn() -> str:
    return os.environ.get("EIL_DATABASE_URL", "postgresql:///eil")


def connect() -> psycopg.Connection:
    return psycopg.connect(dsn())


def migrate() -> list[str]:
    """Apply pending migrations/*.sql in filename order. Returns those applied."""
    applied: list[str] = []
    with connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations").fetchall()}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            applied.append(path.name)
    return applied
