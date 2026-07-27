"""Closed-form rank modifiers — versioned in git, no learned components.

Applied after RRF fusion: quality-tier prior (curated content is the top
prior — a human approved it) times a recency decay with a floor (old docs
fade, never vanish). Curated notes decay on a gentler half-life, but they DO
decay — the curation-rot critique: yesterday's architecture must not be
today's top answer forever.
"""

from __future__ import annotations

from datetime import UTC, datetime

TIER_PRIOR = {"curated": 1.15, "authored": 1.0, "generated": 0.9, "raw": 0.8}
RECENCY_FLOOR = 0.6
HALF_LIFE_DAYS = {"curated": 365.0}
DEFAULT_HALF_LIFE_DAYS = 180.0


def modifier(tier: str, updated_at: datetime | None, now: datetime | None = None) -> float:
    prior = TIER_PRIOR.get(tier, 1.0)
    if updated_at is None:
        return prior * RECENCY_FLOOR  # unknown age is treated as old, not as fresh
    now = now or datetime.now(UTC)
    age_days = max(0.0, (now - updated_at).total_seconds() / 86_400)
    half_life = HALF_LIFE_DAYS.get(tier, DEFAULT_HALF_LIFE_DAYS)
    recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 2 ** (-age_days / half_life)
    return prior * recency
