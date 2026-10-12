"""Internal authentication for service-to-service routes.

The Node agent-service sends a shared secret in the ``X-Internal-Token`` header.
Matching the agent-service's own behavior, auth is only enforced when
``INTERNAL_TOKEN`` is configured; otherwise the endpoint is open (local dev).
"""
from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_internal_token(
    x_internal_token: str | None = Header(default=None),
) -> None:
    expected = get_settings().internal_token
    if not expected:
        return
    if not x_internal_token or not secrets.compare_digest(x_internal_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal token",
        )
