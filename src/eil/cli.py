"""The eil CLI — the only task runner. Cross-platform by construction."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

FixtureOpt = Annotated[Path, typer.Option(exists=True, help="JSON fixture (one item or a list)")]

app = typer.Typer(no_args_is_help=True, add_completion=False)
db_app = typer.Typer(no_args_is_help=True)
ingest_app = typer.Typer(no_args_is_help=True)
app.add_typer(db_app, name="db", help="Database management")
app.add_typer(ingest_app, name="ingest", help="Ingest sources into the catalog")


@db_app.command("migrate")
def db_migrate() -> None:
    """Apply pending SQL migrations."""
    from eil import db

    applied = db.migrate()
    typer.echo(f"applied: {applied}" if applied else "up to date")


def _ingest(normalize, fixture: Path, tenant: str) -> None:
    from eil import db, store

    payloads = json.loads(fixture.read_text(encoding="utf-8"))
    if isinstance(payloads, dict):
        payloads = [payloads]
    changed = 0
    with db.connect() as conn:
        for payload in payloads:
            doc = normalize(payload, tenant=tenant)
            if store.upsert_document(conn, doc):
                changed += 1
                typer.echo(f"  ~ {doc.id}")
    typer.echo(f"{len(payloads)} seen, {changed} changed")


@ingest_app.command("confluence")
def ingest_confluence(fixture: FixtureOpt, tenant: str = "default") -> None:
    """Ingest Confluence pages (phase 0: fixture JSON; live CQL connector in phase 1)."""
    from eil.ingest.confluence import normalize

    _ingest(normalize, fixture, tenant)


@ingest_app.command("jira")
def ingest_jira(fixture: FixtureOpt, tenant: str = "default") -> None:
    """Ingest Jira issues (phase 0: fixture JSON; live JQL connector in phase 1)."""
    from eil.ingest.jira import normalize

    _ingest(normalize, fixture, tenant)


@app.command()
def serve() -> None:
    """Run the MCP server on stdio (wire this into Amp / Claude Code)."""
    from eil.mcp_server import main

    main()


@app.command()
def search(query: str, limit: int = 8) -> None:
    """Debug: run search_docs directly and print the result."""
    from eil import db
    from eil import search as s

    with db.connect() as conn:
        typer.echo(json.dumps(s.search_docs(conn, query, limit), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    app()
