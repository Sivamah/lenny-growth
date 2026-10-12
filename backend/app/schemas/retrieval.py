"""Schemas for the internal retrieval endpoint.

Field names intentionally mirror what the Node agent-service
(`agent-service/src/retrieval.ts`) expects to receive, so the search_transcripts
tool can consume this response without translation.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class RetrieveRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000, description="Natural-language search query")
    top_k: int | None = Field(
        default=None, ge=1, le=50, description="Max results; defaults to RETRIEVAL_TOP_K"
    )


class RetrievedChunkModel(BaseModel):
    chunk_id: str
    transcript_slug: str | None = None
    episode_title: str
    guest: str | None = None
    timestamp: str | None = None
    source_url: str | None = None
    chunk_index: int
    content: str
    score: float


class RetrieveResponse(BaseModel):
    query: str
    grounded: bool
    max_score: float
    source: str = "fastapi"
    results: list[RetrievedChunkModel]
