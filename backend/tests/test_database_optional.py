"""Live-database tests.

These are the only tests that require PostgreSQL. When it is not reachable they
report a skip instead of failing, and they are explicitly reported as unverified
in the task summary. They do NOT substitute SQLite for the real architecture.
"""
from __future__ import annotations

import pytest

from app.db.base import Base, engine
from app.db.session import check_database


async def _postgres_reachable() -> bool:
    reachable, _ = await check_database()
    return reachable


async def test_schema_creates_when_postgres_available():
    if not await _postgres_reachable():
        pytest.skip("PostgreSQL not reachable; live-schema test intentionally skipped")

    async with engine.begin() as conn:
        await conn.execute(__import__("sqlalchemy").text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
