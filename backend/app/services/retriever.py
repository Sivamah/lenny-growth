"""Transcript retrieval over the chunk knowledge base.

On PostgreSQL the similarity search is pushed down to pgvector via the ``<=>``
cosine-distance operator (HNSW-indexed, see migration 0001). A pure-Python
ranking core (:func:`rank_chunks_by_similarity`) is kept separate and free of
any DB or I/O so the *ranking logic* is unit-testable without a database. The
non-Postgres branch exists only so isolated tests can exercise the retriever;
production retrieval is always PostgreSQL + pgvector.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import is_postgres
from app.db.models import Chunk, Transcript
from app.services.embeddings import EmbeddingService


@dataclass
class RetrievedChunk:
    chunk_id: str
    transcript_slug: str | None
    episode_title: str
    guest: str | None
    timestamp: str | None
    source_url: str | None
    chunk_index: int
    content: str
    score: float


@dataclass
class RetrievalOutcome:
    query: str
    grounded: bool
    max_score: float
    results: list[RetrievedChunk] = field(default_factory=list)
    source: str = "fastapi"


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = math.sqrt(sum(x * x for x in a)) or 1e-9
    norm_b = math.sqrt(sum(y * y for y in b)) or 1e-9
    return dot / (norm_a * norm_b)


def rank_chunks_by_similarity(
    query_embedding: list[float],
    candidates: list[tuple[str, list[float]]],
    top_k: int,
) -> list[tuple[str, float]]:
    """Pure ranking: given a query vector and ``[(id, vector), ...]``, return the
    ``top_k`` ids with their cosine similarity, descending."""
    if top_k <= 0:
        return []
    scored = [
        (chunk_id, cosine_similarity(query_embedding, vector))
        for chunk_id, vector in candidates
        if vector
    ]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[:top_k]


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


class Retriever:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def search(self, query_embedding: list[float], top_k: int) -> list[RetrievedChunk]:
        if is_postgres():
            return await self._search_postgres(query_embedding, top_k)
        return await self._search_fallback(query_embedding, top_k)

    async def _search_postgres(
        self, query_embedding: list[float], top_k: int
    ) -> list[RetrievedChunk]:
        rows = (
            await self.db.execute(
                text(
                    """
                    SELECT c.id AS chunk_id,
                           c.chunk_index,
                           c.content,
                           c.start_timestamp,
                           t.slug AS transcript_slug,
                           t.title AS episode_title,
                           t.guest,
                           t.source_url,
                           1 - (c.embedding <=> CAST(:qvec AS vector)) AS score
                    FROM chunks c
                    JOIN transcripts t ON t.id = c.transcript_id
                    WHERE c.embedding IS NOT NULL
                    ORDER BY c.embedding <=> CAST(:qvec AS vector)
                    LIMIT :k
                    """
                ),
                {"qvec": _vector_literal(query_embedding), "k": top_k},
            )
        ).mappings().all()

        return [
            RetrievedChunk(
                chunk_id=str(row["chunk_id"]),
                transcript_slug=row["transcript_slug"],
                episode_title=row["episode_title"],
                guest=row["guest"],
                timestamp=row["start_timestamp"],
                source_url=row["source_url"],
                chunk_index=row["chunk_index"],
                content=row["content"],
                score=float(row["score"]),
            )
            for row in rows
        ]

    async def _search_fallback(
        self, query_embedding: list[float], top_k: int
    ) -> list[RetrievedChunk]:
        chunk_rows = (
            await self.db.execute(select(Chunk).where(Chunk.embedding.is_not(None)))
        ).scalars().all()
        candidates = [(str(c.id), c.embedding or []) for c in chunk_rows]
        ranked = rank_chunks_by_similarity(query_embedding, candidates, top_k)

        by_id = {str(c.id): c for c in chunk_rows}
        transcript_rows = (await self.db.execute(select(Transcript))).scalars().all()
        transcripts_by_id = {str(t.id): t for t in transcript_rows}

        results: list[RetrievedChunk] = []
        for chunk_id, score in ranked:
            chunk = by_id[chunk_id]
            transcript = transcripts_by_id.get(str(chunk.transcript_id))
            results.append(
                RetrievedChunk(
                    chunk_id=chunk_id,
                    transcript_slug=transcript.slug if transcript else None,
                    episode_title=transcript.title if transcript else "",
                    guest=transcript.guest if transcript else None,
                    timestamp=chunk.start_timestamp,
                    source_url=transcript.source_url if transcript else None,
                    chunk_index=chunk.chunk_index,
                    content=chunk.content,
                    score=score,
                )
            )
        return results


async def run_retrieval(
    db: AsyncSession,
    embedder: EmbeddingService,
    query: str,
    top_k: int,
    min_score: float,
) -> RetrievalOutcome:
    """Embed the query and return ranked, grounded-flagged results."""
    query_embedding = await embedder.embed_one(query)
    results = await Retriever(db).search(query_embedding, top_k)
    max_score = max((r.score for r in results), default=0.0)
    return RetrievalOutcome(
        query=query,
        grounded=max_score >= min_score,
        max_score=max_score,
        results=results,
    )
