"""Chat endpoint request/response schemas."""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field, field_validator

MAX_MESSAGE_CHARS = 8000


class ChatRequest(BaseModel):
    session_id: uuid.UUID
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    skill: str | None = Field(default=None, max_length=40)
    """Explicit skill request (e.g. "ship30_essay"). Implicit detection also runs when omitted."""

    @field_validator("message")
    @classmethod
    def validate_non_whitespace(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Message cannot be empty or whitespace-only")
        return v