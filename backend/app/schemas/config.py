"""Public, non-sensitive runtime configuration for frontend clients."""
from __future__ import annotations

from pydantic import BaseModel, Field


class ConfigResponse(BaseModel):
    app_name: str
    version: str
    environment: str
    chat_max_message_chars: int = Field(
        description="Maximum characters the chat endpoint accepts per message"
    )
    retrieval_top_k: int
    retrieval_min_score: float = Field(
        description="Grounding threshold; answers scoring below this are marked ungrounded"
    )