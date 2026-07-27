"""Confluence storage-format (XHTML) -> markdown, deterministically.

Deliberately minimal and stdlib-only: headings, paragraphs, lists, code
blocks, links, emphasis, and tables-as-rows. Anything unrenderable degrades
to its text content rather than leaking markup — and per the design's
conversion-quality rule, a page that converts to garbage should be excluded
upstream, not indexed as noise.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

_HEADINGS = {f"h{i}": "#" * i for i in range(1, 7)}
_SKIP = {"script", "style"}


class _Converter(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.list_stack: list[str] = []  # "ul" | "ol"
        self.ol_counters: list[int] = []
        self.in_pre = False
        self.skip_depth = 0
        self.href: str | None = None

    def _emit(self, text: str) -> None:
        self.out.append(text)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP:
            self.skip_depth += 1
            return
        if tag in _HEADINGS:
            self._emit(f"\n\n{_HEADINGS[tag]} ")
        elif tag == "p":
            self._emit("\n\n")
        elif tag == "br":
            self._emit("\n")
        elif tag in ("ul", "ol"):
            self.list_stack.append(tag)
            self.ol_counters.append(0)
        elif tag == "li":
            indent = "  " * (len(self.list_stack) - 1)
            if self.list_stack and self.list_stack[-1] == "ol":
                self.ol_counters[-1] += 1
                self._emit(f"\n{indent}{self.ol_counters[-1]}. ")
            else:
                self._emit(f"\n{indent}- ")
        elif tag == "pre":
            self.in_pre = True
            self._emit("\n\n```\n")
        elif tag == "code" and not self.in_pre:
            self._emit("`")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "a":
            self.href = dict(attrs).get("href")
            self._emit("[")
        elif tag == "tr":
            self._emit("\n| ")
        elif tag in ("td", "th"):
            pass

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if tag in _HEADINGS or tag == "p":
            self._emit("\n")
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
                self.ol_counters.pop()
            self._emit("\n")
        elif tag == "pre":
            self.in_pre = False
            self._emit("\n```\n")
        elif tag == "code" and not self.in_pre:
            self._emit("`")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "a":
            self._emit(f"]({self.href})" if self.href else "]")
            self.href = None
        elif tag in ("td", "th"):
            self._emit(" | ")

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        self._emit(data if self.in_pre else re.sub(r"\s+", " ", data))


def html_to_markdown(html: str) -> str:
    conv = _Converter()
    conv.feed(html)
    text = "".join(conv.out)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
