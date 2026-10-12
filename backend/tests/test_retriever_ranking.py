"""Pure retrieval-ranking tests (no DB, no HTTP)."""
from __future__ import annotations

from app.services.retriever import cosine_similarity, rank_chunks_by_similarity


def test_cosine_identical_is_one():
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == 1.0


def test_cosine_orthogonal_is_zero():
    assert abs(cosine_similarity([1.0, 0.0], [0.0, 1.0])) < 1e-9


def test_cosine_opposite_is_minus_one():
    assert abs(cosine_similarity([1.0, 0.0], [-1.0, 0.0]) + 1.0) < 1e-9


def test_cosine_handles_zero_vector_without_dividing_by_zero():
    assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0


def test_rank_orders_descending_and_limits_top_k():
    query = [1.0, 0.0]
    candidates = [
        ("low", [0.0, 1.0]),
        ("high", [1.0, 0.0]),
        ("mid", [1.0, 1.0]),
    ]
    ranked = rank_chunks_by_similarity(query, candidates, top_k=2)
    assert [chunk_id for chunk_id, _ in ranked] == ["high", "mid"]
    assert ranked[0][1] >= ranked[1][1]


def test_rank_skips_candidates_without_vectors():
    ranked = rank_chunks_by_similarity([1.0, 0.0], [("empty", []), ("ok", [1.0, 0.0])], top_k=5)
    assert [chunk_id for chunk_id, _ in ranked] == ["ok"]


def test_rank_top_k_zero_returns_empty():
    assert rank_chunks_by_similarity([1.0], [("a", [1.0])], top_k=0) == []


def test_rank_empty_candidates_returns_empty():
    assert rank_chunks_by_similarity([1.0], [], top_k=5) == []
