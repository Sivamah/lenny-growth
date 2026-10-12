"""Grounding-threshold calibration regression test.

Calibration (2026-10) used real ``nomic-embed-text`` embeddings against the live
corpus (10 transcripts, 1567 chunks):

* in-corpus queries (what the episodes actually cover) scored max >= 0.631
* unrelated out-of-corpus queries scored max <= 0.557

``RETRIEVAL_MIN_SCORE`` = 0.60 separates both measured sets. This test re-runs a
representative subset through the real embedder + pgvector pipeline and asserts
the separation still holds. It skips when PostgreSQL or Ollama is unreachable.
"""
from __future__ import annotations

import pytest

from app.config import Settings
from app.db.base import engine
from app.db.session import session_scope, check_database
from app.services.embeddings import EmbeddingService
from app.services.retriever import run_retrieval

TOP_K = 5

IN_CORPUS = [
    "How should a startup think about retention before product market fit?",
    "What is the best way to set pricing for a new product?",
    "When should a company hire their first sales person?",
    "How does Jason Cohen think about growth when the product stops growing?",
    "How do you decide which marketing channel to invest in first?",
]

OUT_OF_CORPUS = [
    "xylophone quantum refraction of illegal smelt fishing in antarctica on tuesday",
    "recipes for baking a chocolate souffle with a pressure cooker",
    "the best way to train a cat to speak french poetry",
    "how do I file taxes for a shipping company in Uzbekistan",
    "quantum entanglement explained with pizza toppings",
]


async def _env_available() -> bool:
    # Connections in the shared asyncpg pool can become bound to the event loop
    # of an earlier live-DB test; dispose first so the probe gets fresh ones.
    await engine.dispose()
    reachable, _ = await check_database()
    if not reachable:
        return False
    return await EmbeddingService(Settings()).is_available()


async def _max_scores(queries: list[str]) -> list[float]:
    settings = Settings()
    embedder = EmbeddingService(settings)
    scores: list[float] = []
    async with session_scope() as db:
        for query in queries:
            outcome = await run_retrieval(db, embedder, query, TOP_K, settings.retrieval_min_score)
            scores.append(outcome.max_score)
    return scores


async def test_calibrated_threshold_still_separates_measured_sets():
    if not await _env_available():
        pytest.skip("PostgreSQL or Ollama unreachable; live grounding calibration skipped")

    settings = Settings()
    threshold = settings.retrieval_min_score

    in_corpus = await _max_scores(IN_CORPUS)
    out_of_corpus = await _max_scores(OUT_OF_CORPUS)

    assert all(score >= threshold for score in in_corpus), (
        f"in-corpus query fell below RETRIEVAL_MIN_SCORE={threshold}: {in_corpus}"
    )
    assert all(score < threshold for score in out_of_corpus), (
        f"out-of-corpus query exceeded RETRIEVAL_MIN_SCORE={threshold}: {out_of_corpus}"
    )
    # Margin requirement keeps the calibration honest: the two sets must not just
    # be on their correct side of the threshold, they must be clearly separable.
    assert min(in_corpus) > max(out_of_corpus), (
        f"measured sets overlap: in-corpus min {min(in_corpus):.3f} "
        f"<= out-of-corpus max {max(out_of_corpus):.3f}"
    )