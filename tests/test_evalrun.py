from pathlib import Path

from eil.evalrun import parse_golden

GOLDEN = Path(__file__).parents[1] / "docs" / "golden-queries.md"


def test_parses_repo_golden_file():
    entries = parse_golden(GOLDEN)
    assert len(entries) >= 2
    by_query = {e.query: e.expected for e in entries}
    assert by_query["PAY-981"] == ["jira:issue:PAY-981"]
    assert by_query["how do payment retries work"] == ["confluence:page:12345"]


def test_parser_handles_multiple_ids_and_ignores_prose(tmp_path):
    md = tmp_path / "g.md"
    md.write_text(
        "# Golden\n\nsome prose\n\n"
        "- `retry policy` → confluence:page:1, obsidian:note:x — note here\n"
        "- not an entry line\n",
        encoding="utf-8",
    )
    entries = parse_golden(md)
    assert len(entries) == 1
    assert entries[0].expected == ["confluence:page:1", "obsidian:note:x"]
