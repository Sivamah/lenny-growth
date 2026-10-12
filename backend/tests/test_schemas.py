"""Pydantic schema tests (pure, no DB)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.schemas.health import DependencyStatus, HealthResponse
from app.schemas.session import MessageRead, SessionCreate, SessionRead


def test_health_response_shape():
    response = HealthResponse(
        status="ok",
        app_name="Lenny",
        version="0.2.0",
        environment="test",
        dependencies=[DependencyStatus(name="database", reachable=True)],
    )
    assert response.dependencies[0].name == "database"
    assert response.dependencies[0].detail is None


def test_session_create_defaults():
    payload = SessionCreate()
    assert payload.title is None
    assert payload.user_label is None
    assert payload.meta == {}


def test_session_read_serializes_orm_like_object():
    class _Row:
        pass

    row = _Row()
    row.id = uuid.uuid4()
    row.title = "Thread"
    row.user_label = None
    row.meta = {"k": "v"}
    row.created_at = datetime.now(timezone.utc)
    row.updated_at = datetime.now(timezone.utc)
    row.messages = []

    model = SessionRead.model_validate(row)
    assert model.id == row.id
    assert model.meta == {"k": "v"}
    assert model.messages == []


def test_message_read_requires_core_fields():
    message = MessageRead(
        id=uuid.uuid4(),
        role="assistant",
        content="hi",
        created_at=datetime.now(timezone.utc),
    )
    assert message.citations == []
    assert message.provider is None
