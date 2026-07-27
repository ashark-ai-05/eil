"""The eil CLI — the only task runner. Cross-platform by construction."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

FixtureOpt = Annotated[
    Path | None, typer.Option(exists=True, help="JSON fixture (one item or a list); omit for live sync")
]

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


def _ingest(source: str, normalize, payloads, tenant: str, cursor_of=None) -> None:
    from eil import db, store

    seen = changed = 0
    latest: str | None = None
    with db.connect() as conn:
        for payload in payloads:
            seen += 1
            doc = normalize(payload, tenant=tenant)
            if store.upsert_document(conn, doc):
                changed += 1
                typer.echo(f"  ~ {doc.id}")
            if cursor_of and (value := cursor_of(payload)):
                latest = max(latest or value, value)
        if latest:
            store.set_cursor(conn, source, latest)
    typer.echo(f"{seen} seen, {changed} changed" + (f", cursor -> {latest}" if latest else ""))


def _client(cls, required_env: str):
    try:
        return cls()
    except KeyError as exc:
        typer.echo(f"live sync needs {required_env} set (personal credentials); missing {exc}")
        raise typer.Exit(1) from exc


def _fixture_payloads(fixture: Path):
    payloads = json.loads(fixture.read_text(encoding="utf-8"))
    return payloads if isinstance(payloads, list) else [payloads]


@ingest_app.command("confluence")
def ingest_confluence(fixture: FixtureOpt = None, tenant: str = "default") -> None:
    """Ingest Confluence pages — fixture JSON, or live CQL sync from the cursor."""
    from eil.ingest.confluence import normalize

    if fixture:
        _ingest("confluence", normalize, _fixture_payloads(fixture), tenant)
        return
    from eil import db, store
    from eil.connectors.confluence import ConfluenceClient

    with db.connect() as conn:
        cursor = store.get_cursor(conn, "confluence")
    typer.echo(f"live sync from cursor: {cursor or '(beginning)'}")
    client = _client(ConfluenceClient, "EIL_CONFLUENCE_URL and EIL_CONFLUENCE_TOKEN")
    _ingest("confluence", normalize, client.updated_since(cursor), tenant,
            cursor_of=lambda p: p.get("updated"))


@ingest_app.command("jira")
def ingest_jira(fixture: FixtureOpt = None, tenant: str = "default") -> None:
    """Ingest Jira issues — fixture JSON, or live JQL sync from the cursor."""
    from eil.ingest.jira import normalize

    if fixture:
        _ingest("jira", normalize, _fixture_payloads(fixture), tenant)
        return
    from eil import db, store
    from eil.connectors.jira import JiraClient

    with db.connect() as conn:
        cursor = store.get_cursor(conn, "jira")
    typer.echo(f"live sync from cursor: {cursor or '(beginning)'}")
    client = _client(JiraClient, "EIL_JIRA_URL and EIL_JIRA_TOKEN")
    _ingest("jira", normalize, client.updated_since(cursor), tenant,
            cursor_of=lambda p: p["fields"].get("updated"))


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
