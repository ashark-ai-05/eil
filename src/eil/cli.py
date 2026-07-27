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

    seen = changed = failed = 0
    latest: str | None = None
    retry_from: str | None = None  # earliest failed timestamp — cursor never passes it
    with db.connect() as conn:
        for payload in payloads:
            seen += 1
            value = cursor_of(payload) if cursor_of else None
            try:
                doc = normalize(payload, tenant=tenant)
                if store.upsert_document(conn, doc):
                    changed += 1
                    typer.echo(f"  ~ {doc.id}")
                conn.commit()  # per-doc commit: one bad record can't starve the batch
            except Exception as exc:  # noqa: BLE001 — keep syncing; re-fetch failures next run
                conn.rollback()
                failed += 1
                typer.echo(f"  ! failed ({exc.__class__.__name__}): {exc}")
                if value and (retry_from is None or value < retry_from):
                    retry_from = value
                continue
            if value:
                latest = max(latest or value, value)
        # Advance to the newest success, but never beyond the earliest failure:
        # the next run re-fetches from there and the hash gate makes redone
        # work free.
        target = retry_from or latest
        if target:
            store.set_cursor(conn, source, target)
    summary = f"{seen} seen, {changed} changed"
    if failed:
        summary += f", {failed} FAILED (cursor held at {target})"
    elif latest:
        summary += f", cursor -> {latest}"
    typer.echo(summary)


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

    client = _client(ConfluenceClient, "EIL_CONFLUENCE_URL and EIL_CONFLUENCE_TOKEN")
    with db.connect() as conn:
        cursor = store.get_cursor(conn, "confluence")
    typer.echo(f"live sync from cursor: {cursor or '(beginning)'}")
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

    client = _client(JiraClient, "EIL_JIRA_URL and EIL_JIRA_TOKEN")
    with db.connect() as conn:
        cursor = store.get_cursor(conn, "jira")
    typer.echo(f"live sync from cursor: {cursor or '(beginning)'}")
    _ingest("jira", normalize, client.updated_since(cursor), tenant,
            cursor_of=lambda p: p["fields"].get("updated"))


@ingest_app.command("obsidian")
def ingest_obsidian(
    vault: Annotated[Path, typer.Option(exists=True, file_okay=False, help="Vault root directory")],
    tenant: str = "default",
) -> None:
    """Ingest an Obsidian vault (markdown files; curated quality tier)."""
    from eil.ingest.obsidian import walk_vault

    _ingest("obsidian", lambda d, tenant: d, walk_vault(vault, tenant), tenant)


@app.command("eval")
def eval_cmd(
    k: int = 10,
    min_recall: Annotated[float, typer.Option(help="Exit non-zero below this mean recall")] = 0.0,
    golden: Path = Path("docs/golden-queries.md"),
) -> None:
    """Run the golden-query eval: recall@k through the real retrieval path."""
    from eil import db, evalrun
    from eil.search import Viewer

    entries = evalrun.parse_golden(golden)
    if not entries:
        typer.echo(f"no golden entries found in {golden}")
        raise typer.Exit(1)
    with db.connect() as conn:
        report = evalrun.run(conn, Viewer.local(), entries, k)
        evalrun.record(conn, report)
    for q in report["queries"]:
        marker = "ok " if q["recall"] == 1.0 else "MISS"
        typer.echo(f"  {marker} recall={q['recall']:.2f}  `{q['query']}`"
                   + (f"  missing: {q['missing']}" if q["missing"] else ""))
    typer.echo(f"mean recall@{k}: {report['mean_recall']} over {len(entries)} queries")
    if report["mean_recall"] < min_recall:
        raise typer.Exit(2)


@app.command()
def report(out: Path = Path("docs/metrics-report.html")) -> None:
    """Generate the self-contained HTML metrics report from the metrics views."""
    from eil import db
    from eil import report as r

    with db.connect() as conn:
        html_text = r.render(r.collect(conn))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html_text, encoding="utf-8")
    typer.echo(f"wrote {out}")


@app.command()
def serve() -> None:
    """Run the MCP server on stdio (wire this into Amp / Claude Code)."""
    from eil.mcp_server import main

    main()


@app.command()
def search(query: str, limit: int = 8) -> None:
    """Debug: run search_docs through the tool registry (audited, like MCP)."""
    from eil import tools

    result = tools.call_tool("search_docs", {"query": query, "limit": limit})
    typer.echo(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    app()
