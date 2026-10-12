"""Health response schemas."""
from __future__ import annotations

from pydantic import BaseModel, Field


class DependencyStatus(BaseModel):
    """Reachability of one downstream dependency."""

    name: str
    reachable: bool
    detail: str | None = None


class HealthResponse(BaseModel):
    status: str = Field(description='"ok" when all required deps are reachable, else "degraded"')
    app_name: str
    version: str
    environment: str
    dependencies: list[DependencyStatus]
