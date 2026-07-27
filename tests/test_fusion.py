from eil.fusion import rrf


def test_agreement_wins():
    fused = rrf({"fts": ["a", "b", "c"], "knn": ["b", "a", "d"]})
    assert [doc for doc, _ in fused][:2] == ["a", "b"] or [doc for doc, _ in fused][:2] == ["b", "a"]
    # both arms rank a and b above c and d
    top_two = {doc for doc, _ in fused[:2]}
    assert top_two == {"a", "b"}


def test_deterministic_tiebreak_on_doc_id():
    # symmetric rankings -> equal scores -> doc id ascending decides
    fused = rrf({"x": ["b", "a"], "y": ["a", "b"]})
    assert [doc for doc, _ in fused] == ["a", "b"]


def test_weights_shift_ranking():
    unweighted = rrf({"fts": ["a"], "knn": ["b"]})
    weighted = rrf({"fts": ["a"], "knn": ["b"]}, weights={"fts": 2.0})
    assert unweighted[0][0] == "a"  # tiebreak
    assert weighted[0][0] == "a" and weighted[0][1] > weighted[1][1]


def test_single_arm_passthrough_order():
    fused = rrf({"fts": ["z", "m", "a"]})
    assert [doc for doc, _ in fused] == ["z", "m", "a"]
