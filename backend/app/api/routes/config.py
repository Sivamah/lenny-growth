"""Public client-facing configuration endpoint.

Exposes only non-sensitive knobs the UI needs (identity, chat input limits,
grounding threshold). Reachability is `GET /health`'s job — this endpoint never
touches the database or the agent-service.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import get_settings
from app.schemas.chat import MAX_MESSAGE_CHARS
from app.schemas.config import ConfigResponse

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config", response_model=ConfigResponse)
async def config() -> ConfigResponse:
    settings = get_settings()
    return ConfigResponse(
        app_name=settings.app_name,
        version=settings.api_version,
        environment=settings.environment,
        chat_max_message_chars=MAX_MESSAGE_CHARS,
        retrieval_top_k=settings.retrieval_top_k,
        retrieval_min_score=settings.retrieval_min_score,
    )