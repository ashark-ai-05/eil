"""Golden-query eval: recall@k over docs/golden-queries.md.

The golden log is the human-maintained source of truth (real queries from
real usage); this module parses it, runs each query through the actual
retrieval path, and reports per-query and mean recall. Runs in CI so every
chunker/ranking/router change answers for its retrieval impact.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import psycopg

from eil.search import Viewer, search_docs

_ENTRY_RE = re.compile(r"^- `(?P<query>.+?)` → (?P<ids>[^—\n]+)")


@dataclass(frozen=True)
class GoldenEntry:
    query: str
    expected: list[str]


def parse_golden(path: Path) -> list[GoldenEntry]:
    entries = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if m := _ENTRY_RE.match(line.strip()):
            ids = [i.strip() for i in m.group("ids").split(",") if i.strip()]
            entries.append(GoldenEntry(m.group("query"), ids))
    return entries


def _retrieved_ids(result: dict, k: int) -> list[str]:
    if "entity" in result:  # entity route: the resolved doc plus its neighborhood
        ids = [result["entity"]["id"]] if result.get("entity") else []
        ids += [e["id"] for e in result.get("linked", [])]
        return ids[:k]
    return [r["id"] for r in result.get("results", [])][:k]


def run(
    conn: psycopg.Connection, viewer: Viewer, entries: list[GoldenEntry], k: int = 10
) -> dict:
    per_query = []
    for entry in entries:
        got = _retrieved_ids(search_docs(conn, viewer, entry.query, limit=k), k)
        hits = [e for e in entry.expected if e in got]
        per_query.append(
            {
                "query": entry.query,
                "recall": len(hits) / len(entry.expected) if entry.expected else 1.0,
                "expected": entry.expected,
                "missing": [e for e in entry.expected if e not in got],
            }
        )
    mean = sum(q["recall"] for q in per_query) / len(per_query) if per_query else 0.0
    return {"k": k, "mean_recall": round(mean, 4), "queries": per_query}


def git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return out.stdout.strip() or "unknown"
    except OSError:
        return "unknown"


def record(conn: psycopg.Connection, report: dict) -> None:
    """Persist a run into metrics.eval_runs — trend, not snapshot."""
    misses = [
        {"query": q["query"], "missing": q["missing"]}
        for q in report["queries"] if q["missing"]
    ]
    conn.execute(
        "INSERT INTO metrics.eval_runs (git_sha, k, mean_recall, queries, misses)"
        " VALUES (%s, %s, %s, %s, %s)",
        (git_sha(), report["k"], report["mean_recall"], len(report["queries"]), json.dumps(misses)),
    )
