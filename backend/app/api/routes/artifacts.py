"""Artifact endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.db.models import Artifact
from app.schemas.artifact import ArtifactRead, ArtifactSummary
from app.services.content_sanitizer import sanitize_artifact

router = APIRouter(tags=["artifacts"])


def _db_unavailable(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Database unavailable: {exc}",
    )


@router.get("/sessions/{session_id}/artifacts", response_model=list[ArtifactSummary])
async def list_session_artifacts(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[Artifact]:
    try:
        result = await db.execute(
            select(Artifact)
            .where(Artifact.session_id == session_id)
            .order_by(Artifact.created_at.asc())
        )
        return list(result.scalars().all())
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc


@router.get("/artifacts/{artifact_id}", response_model=ArtifactRead)
async def get_artifact(
    artifact_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ArtifactRead:
    try:
        artifact = await db.get(Artifact, artifact_id)
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc

    if artifact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found")

    # Defense in depth: re-sanitize on read so artifacts persisted before the
    # write-time policy existed (or by any other writer) are still safe.
    return ArtifactRead.model_validate(artifact).model_copy(
        update={"content": sanitize_artifact(artifact.kind, artifact.content)}
    )
