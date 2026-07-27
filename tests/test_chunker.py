"""Golden-file contract for the chunker.

If a deliberate chunker change alters output, regenerate with:
    uv run python tests/test_chunker.py --regen
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from eil.chunker import MAX_CHARS, chunk
from eil.ingest.confluence import normalize

FIXTURE = Path(__file__).parent / "fixtures" / "confluence_page.json"
GOLDEN = Path(__file__).parent / "golden" / "confluence_page.chunks.json"


def _chunks() -> list[dict]:
    doc = normalize(json.loads(FIXTURE.read_text(encoding="utf-8")))
    return [c.model_dump() for c in chunk(doc)]


def test_chunker_matches_golden():
    assert GOLDEN.exists(), "golden file missing — run: uv run python tests/test_chunker.py --regen"
    assert _chunks() == json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_chunker_is_deterministic():
    assert _chunks() == _chunks()


def test_every_chunk_carries_breadcrumb():
    for c in _chunks():
        assert c["text"].startswith(c["heading_path"])
        assert c["heading_path"].startswith("Payment Retry Policy")


def test_chunk_size_bounded():
    for c in _chunks():
        assert len(c["text"]) <= MAX_CHARS + len(c["heading_path"]) + 2


if __name__ == "__main__" and "--regen" in sys.argv:
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(_chunks(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"regenerated {GOLDEN}")
