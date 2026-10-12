"""Health endpoint — reports API status and dependency reachability without
crashing when an optional dependency is unavailable."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_agent_client
from app.config import get_settings
from app.db.session import check_database
from app.schemas.health import DependencyStatus, HealthResponse
from app.services.agent_client import AgentServiceClient

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(
    agent_client: AgentServiceClient = Depends(get_agent_client),
) -> HealthResponse:
    settings = get_settings()

    db_ok, db_error = await check_database()
    agent_ok = await agent_client.health()

    dependencies = [
        DependencyStatus(name="database", reachable=db_ok, detail=db_error),
        DependencyStatus(
            name="agent_service",
            reachable=agent_ok,
            detail=None if agent_ok else f"unreachable at {agent_client.base_url}",
        ),
    ]

    return HealthResponse(
        status="ok" if db_ok and agent_ok else "degraded",
        app_name=settings.app_name,
        version=settings.api_version,
        environment=settings.environment,
        dependencies=dependencies,
    )
