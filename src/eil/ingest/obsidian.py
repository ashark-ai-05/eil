"""Obsidian vault connector — the curation layer.

A vault is git-synced markdown; everything in it is quality_tier=curated (a
human wrote or approved it), the top ranking prior. [[wikilinks]] feed the
same link graph as ticket keys. This is also the write-back target: workflows
propose notes as PRs, humans merge, the corpus compounds.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from eil.ingest.common import extract_links
from eil.models import CanonicalDoc


def note_id(vault_root: Path, path: Path) -> str:
    rel = path.relative_to(vault_root).with_suffix("")
    return f"obsidian:note:{rel.as_posix()}"


def normalize_note(vault_root: Path, path: Path, tenant: str = "default") -> CanonicalDoc:
    body = path.read_text(encoding="utf-8")
    doc_id = note_id(vault_root, path)
    rel = path.relative_to(vault_root)
    title = path.stem
    for line in body.split("\n"):
        if line.startswith("# "):
            title = line[2:].strip()
            break
    return CanonicalDoc(
        id=doc_id,
        tenant=tenant,
        source="obsidian",
        title=title,
        author=None,
        updated_at=datetime.fromtimestamp(path.stat().st_mtime, tz=UTC),
        hierarchy=list(rel.parts[:-1]),
        acl_groups=[],
        quality_tier="curated",
        body=body,
        links=extract_links(body, doc_id),
    )


def walk_vault(vault_root: Path, tenant: str = "default") -> list[CanonicalDoc]:
    return [
        normalize_note(vault_root, p, tenant)
        for p in sorted(vault_root.rglob("*.md"))
        if ".obsidian" not in p.parts and ".trash" not in p.parts
    ]
