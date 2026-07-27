from pathlib import Path

from eil.ingest.obsidian import walk_vault


def _vault(tmp_path: Path) -> Path:
    (tmp_path / "payments").mkdir()
    (tmp_path / ".obsidian").mkdir()
    (tmp_path / "payments" / "retry-policy.md").write_text(
        "# Retry Policy Notes\n\nSee [[payments/parked-payments-runbook]] and PAY-981.\n",
        encoding="utf-8",
    )
    (tmp_path / ".obsidian" / "config.md").write_text("internal", encoding="utf-8")
    (tmp_path / "inbox.md").write_text("no heading here\n", encoding="utf-8")
    return tmp_path


def test_walk_vault_normalizes_notes(tmp_path):
    docs = walk_vault(_vault(tmp_path))
    ids = [d.id for d in docs]
    assert "obsidian:note:payments/retry-policy" in ids
    assert "obsidian:note:inbox" in ids
    assert not any(".obsidian" in i for i in ids)

    note = next(d for d in docs if d.id.endswith("retry-policy"))
    assert note.title == "Retry Policy Notes"  # first heading wins
    assert note.hierarchy == ["payments"]
    assert note.quality_tier == "curated"
    assert "jira:issue:PAY-981" in note.links
    assert "obsidian:note:payments/parked-payments-runbook" in note.links

    inbox = next(d for d in docs if d.id.endswith("inbox"))
    assert inbox.title == "inbox"  # filename fallback


def test_walk_is_deterministic_order(tmp_path):
    vault = _vault(tmp_path)
    assert [d.id for d in walk_vault(vault)] == [d.id for d in walk_vault(vault)]
