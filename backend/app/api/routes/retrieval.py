"""Internal retrieval endpoint consumed by the Node agent-service.

``POST /internal/retrieve`` embeds the query with the same local Ollama model
used at ingestion time, ranks stored chunks with pgvector, and returns citable
passages plus a grounding indicator. Errors are mapped to safe statuses; no
internal stack traces or credentials are returned to the caller.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, get_embedder
from app.api.security import require_internal_token
from app.config import get_settings
from app.schemas.retrieval import RetrieveRequest, RetrieveResponse, RetrievedChunkModel
from app.services.embeddings import EmbeddingError, EmbeddingService
from app.services.retriever import run_retrieval

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["retrieval"])


@router.post(
    "/retrieve",
    response_model=RetrieveResponse,
    dependencies=[Depends(require_internal_token)],
)
async def retrieve(
    payload: RetrieveRequest,
    db: AsyncSession = Depends(get_db),
    embedder: EmbeddingService = Depends(get_embedder),
) -> RetrieveResponse:
    settings = get_settings()
    top_k = payload.top_k or settings.retrieval_top_k

    try:
        outcome = await run_retrieval(
            db,
            embedder,
            payload.query,
            top_k,
            settings.retrieval_min_score,
        )
    except EmbeddingError as exc:
        logger.warning("retrieval_embedding_failed", extra={"error": str(exc)})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Embedding service unavailable",
        ) from exc
    except SQLAlchemyError as exc:
        logger.warning("retrieval_db_error", extra={"error": str(exc)})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from exc

    return RetrieveResponse(
        query=outcome.query,
        grounded=outcome.grounded,
        max_score=outcome.max_score,
        source=outcome.source,
        results=[
            RetrievedChunkModel.model_validate(chunk, from_attributes=True)
            for chunk in outcome.results
        ],
    )
