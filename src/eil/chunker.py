"""Structure-aware markdown chunker.

Deterministic by construction: same body in, same chunks out, byte for byte.
The golden-file tests in tests/test_chunker.py are the contract — any change
to this file that alters existing output must update the goldens knowingly.

Chunks are split on headings, packed to a target size, and prefixed with
their heading breadcrumb so each chunk is self-describing in both lexical
and (later) embedding space.
"""

from __future__ import annotations

import re

from eil.models import CanonicalDoc, Chunk

# ~400-800 tokens at the usual ~4 chars/token.
MAX_CHARS = 3200
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def _sections(body: str, root: list[str]) -> list[tuple[str, str]]:
    """Split markdown into (breadcrumb, text) sections at heading boundaries."""
    stack: list[tuple[int, str]] = []  # (level, title)
    sections: list[tuple[str, list[str]]] = []
    current: list[str] = []

    def breadcrumb() -> str:
        return " > ".join(root + [t for _, t in stack])

    sections.append((breadcrumb(), current))
    for line in body.split("\n"):
        m = _HEADING_RE.match(line)
        if m:
            level, title = len(m.group(1)), m.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            current = []
            sections.append((breadcrumb(), current))
        else:
            current.append(line)
    return [(bc, "\n".join(lines).strip()) for bc, lines in sections if "\n".join(lines).strip()]


def _pack(text: str) -> list[str]:
    """Split an oversized section on paragraph boundaries, hard-wrapping only as a last resort."""
    if len(text) <= MAX_CHARS:
        return [text]
    parts: list[str] = []
    buf = ""
    for para in text.split("\n\n"):
        while len(para) > MAX_CHARS:  # single pathological paragraph
            parts.append(para[:MAX_CHARS])
            para = para[MAX_CHARS:]
        if buf and len(buf) + len(para) + 2 > MAX_CHARS:
            parts.append(buf)
            buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
    if buf:
        parts.append(buf)
    return parts


def chunk(doc: CanonicalDoc) -> list[Chunk]:
    chunks: list[Chunk] = []
    for heading_path, text in _sections(doc.body, [doc.title]):
        for piece in _pack(text):
            chunks.append(
                Chunk(
                    doc_id=doc.id,
                    seq=len(chunks),
                    heading_path=heading_path,
                    text=f"{heading_path}\n\n{piece}",
                )
            )
    return chunks
