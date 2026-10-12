"""Dialect-aware embedding column type.

On PostgreSQL this is a real `pgvector` `vector(N)` column that pgvector can
index and query with `<=>`. The type degrades to JSON on other dialects purely
so isolated unit tests can import the models without a live database. Production
similarity search always runs on PostgreSQL + pgvector.
"""
from __future__ import annotations

from sqlalchemy.types import JSON, TypeDecorator

try:  # pgvector is a hard dependency, but keep import failure non-fatal at import time
    from pgvector.sqlalchemy import Vector as _PgVectorType
except Exception:  # pragma: no cover - exercised only if pgvector is missing
    _PgVectorType = None  # type: ignore[assignment,misc]


class Vector(TypeDecorator):
    """`vector(dim)` on PostgreSQL; JSON elsewhere (tests only)."""

    impl = JSON
    cache_ok = True

    def __init__(self, dim: int):
        super().__init__()
        self.dim = dim

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql" and _PgVectorType is not None:
            return dialect.type_descriptor(_PgVectorType(self.dim))
        return dialect.type_descriptor(JSON())
