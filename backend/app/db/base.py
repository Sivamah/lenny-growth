"""Async SQLAlchemy engine, session factory, and declarative base.

The engine is created lazily (no connection is opened until first use), so
importing models or the app never requires a running PostgreSQL instance.
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()


def _connect_args(database_url: str) -> dict[str, object]:
    if database_url.startswith("postgresql"):
        # asyncpg.connect(timeout=...) bounds the TCP/handshake wait so the
        # /health probe fails fast instead of hanging when Postgres is down.
        return {"timeout": settings.db_connect_timeout_seconds}
    return {}


def build_engine(database_url: str | None = None, *, echo: bool | None = None) -> AsyncEngine:
    url = database_url or settings.database_url
    kwargs: dict[str, object] = {
        "echo": settings.db_echo if echo is None else echo,
        "pool_pre_ping": True,
        "connect_args": _connect_args(url),
    }
    if not url.startswith("sqlite"):
        kwargs["pool_size"] = settings.db_pool_size
        kwargs["max_overflow"] = settings.db_max_overflow
    return create_async_engine(url, **kwargs)


engine = build_engine()
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def is_postgres() -> bool:
    return engine.dialect.name == "postgresql"
