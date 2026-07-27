"""Reciprocal Rank Fusion — owned in-service, deterministic, engine-agnostic.

Pure arithmetic on ranks with a fixed k and a stable tiebreak on doc id, so
the fusion layer is portable across Postgres FTS, pgvector, OpenSearch, or
anything else an executor returns. Weights and k are config, versioned in git.
"""

from __future__ import annotations

RRF_K = 60


def rrf(
    rankings: dict[str, list[str]],
    weights: dict[str, float] | None = None,
    k: int = RRF_K,
) -> list[tuple[str, float]]:
    """Fuse named ranked lists of doc ids into one ranking.

    rankings: arm name -> doc ids, best first.
    Returns (doc_id, score) sorted by score desc, then doc_id asc (stable tiebreak).
    """
    weights = weights or {}
    scores: dict[str, float] = {}
    for arm, ranked in rankings.items():
        w = weights.get(arm, 1.0)
        for rank, doc_id in enumerate(ranked):
            scores[doc_id] = scores.get(doc_id, 0.0) + w / (k + rank + 1)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))
