"""Session and message schemas."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SessionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    user_label: str | None = Field(default=None, max_length=200)
    meta: dict[str, Any] = Field(default_factory=dict)


class SessionUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    user_label: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _at_least_one_field(self) -> "SessionUpdate":
        if self.title is None and self.user_label is None:
            raise ValueError("provide at least one of title or user_label")
        return self


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    role: str
    content: str
    provider: str | None = None
    skill: str | None = None
    citations: list[Any] = Field(default_factory=list)
    model: str | None = None
    grounding: dict[str, Any] | None = None
    token_usage: dict[str, Any] | None = None
    created_at: datetime


class SessionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str | None = None
    user_label: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class SessionRead(SessionSummary):
    messages: list[MessageRead] = Field(default_factory=list)
