"""Async session management and a safe database reachability probe."""
from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import SessionLocal, engine

logger = logging.getLogger(__name__)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a request-scoped async session."""
    async with SessionLocal() as session:
        yield session


@asynccontextmanager
async def session_scope() -> AsyncGenerator[AsyncSession, None]:
    """Context manager for background tasks: commits on success, rolls back on error."""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def check_database() -> tuple[bool, str | None]:
    """Return (reachable, error). Never raises — safe for /health."""
    try:
        async with SessionLocal() as session:
            await session.execute(text("SELECT 1"))
        return True, None
    except Exception as exc:  # noqa: BLE001 - health probe must never propagate
        logger.warning("database_unreachable", extra={"error": str(exc)})
        return False, str(exc)


async def dispose_engine() -> None:
    await engine.dispose()
