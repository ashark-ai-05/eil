from datetime import UTC, datetime, timedelta

from eil.ranking import RECENCY_FLOOR, TIER_PRIOR, modifier

NOW = datetime(2026, 7, 27, tzinfo=UTC)


def test_fresh_authored_doc_is_neutral():
    assert modifier("authored", NOW, NOW) == 1.0


def test_curated_prior_beats_authored():
    assert modifier("curated", NOW, NOW) > modifier("authored", NOW, NOW)


def test_decay_halves_at_half_life_above_floor():
    half_life_ago = NOW - timedelta(days=180)
    expected = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5
    assert abs(modifier("authored", half_life_ago, NOW) - expected) < 1e-9


def test_curated_decays_slower_but_does_decay():
    year_ago = NOW - timedelta(days=365)
    curated = modifier("curated", year_ago, NOW) / TIER_PRIOR["curated"]
    authored = modifier("authored", year_ago, NOW)
    assert curated > authored  # gentler half-life
    assert curated < 1.0  # curation rot rule: curated content still decays


def test_floor_holds_for_ancient_docs():
    ancient = NOW - timedelta(days=10_000)
    assert modifier("authored", ancient, NOW) >= RECENCY_FLOOR * 0.999


def test_unknown_age_treated_as_old():
    assert modifier("authored", None, NOW) == TIER_PRIOR["authored"] * RECENCY_FLOOR


def test_deterministic():
    ts = NOW - timedelta(days=42)
    assert modifier("generated", ts, NOW) == modifier("generated", ts, NOW)
