"""Artifact schemas."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ArtifactSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    message_id: uuid.UUID | None = None
    kind: str
    title: str | None = None
    created_at: datetime


class ArtifactRead(ArtifactSummary):
    content: str
