"""Session endpoints (create / list / read / rename / delete / messages).

These persist to PostgreSQL. When the database is unreachable they degrade to a
503 instead of crashing; request-validation errors (422) still occur before any
database access, which is what the DB-free unit tests assert.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_db
from app.db.models import ChatSession, Message
from app.schemas.session import MessageRead, SessionCreate, SessionRead, SessionSummary, SessionUpdate

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _db_unavailable(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Database unavailable: {exc}",
    )


@router.post("", response_model=SessionRead, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate,
    db: AsyncSession = Depends(get_db),
) -> ChatSession:
    session = ChatSession(title=payload.title, user_label=payload.user_label, meta=payload.meta)
    try:
        db.add(session)
        await db.commit()
        await db.refresh(session, attribute_names=["messages"])
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc
    return session


@router.get("", response_model=list[SessionSummary])
async def list_sessions(db: AsyncSession = Depends(get_db)) -> list[ChatSession]:
    try:
        result = await db.execute(
            select(ChatSession).order_by(ChatSession.created_at.desc()).limit(100)
        )
        return list(result.scalars().all())
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc


@router.get("/{session_id}", response_model=SessionRead)
async def get_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ChatSession:
    try:
        result = await db.execute(
            select(ChatSession)
            .where(ChatSession.id == session_id)
            .options(selectinload(ChatSession.messages))
        )
        session = result.scalar_one_or_none()
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session


async def _session_exists(db: AsyncSession, session_id: uuid.UUID) -> bool:
    result = await db.execute(select(ChatSession.id).where(ChatSession.id == session_id))
    return result.scalar_one_or_none() is not None


@router.get("/{session_id}/messages", response_model=list[MessageRead])
async def get_session_messages(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[Message]:
    try:
        if not await _session_exists(db, session_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Session not found"
            )
        result = await db.execute(
            select(Message)
            .where(Message.session_id == session_id)
            .order_by(Message.created_at.asc(), Message.id.asc())
        )
        messages = list(result.scalars().all())
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc
    return messages


@router.patch("/{session_id}", response_model=SessionSummary)
async def rename_session(
    session_id: uuid.UUID,
    payload: SessionUpdate,
    db: AsyncSession = Depends(get_db),
) -> ChatSession:
    try:
        result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
        session = result.scalar_one_or_none()
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Session not found"
            )
        if payload.title is not None:
            session.title = payload.title
        if payload.user_label is not None:
            session.user_label = payload.user_label
        await db.commit()
        await db.refresh(session)
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc
    return session


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    try:
        if not await _session_exists(db, session_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Session not found"
            )
        await db.execute(delete(ChatSession).where(ChatSession.id == session_id))
        await db.commit()
    except SQLAlchemyError as exc:
        raise _db_unavailable(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
