"""Session rename/delete/messages persistence tests.

DB-free: the `get_db` dependency is overridden with a fake session that
satisfies the subset of SQLAlchemy API the routes use (select/delete,
scalar_one_or_none, scalars, commit, refresh). Covers request validation (422),
not-found (404), success shapes, and DB-failure mapping (503).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import Delete, Select, delete, select
from sqlalchemy.exc import OperationalError

from app.api.deps import get_db
from app.main import app

SESSION_ID = uuid.uuid4()

TITLED = SimpleNamespace(
    id=SESSION_ID,
    title="Growth questions",
    user_label=None,
    meta={},
    created_at=datetime.now(timezone.utc),
    updated_at=datetime.now(timezone.utc),
)


def _message(role: str, content: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        role=role,
        content=content,
        provider="ollama",
        skill=None,
        citations=[],
        model="llama3.2:3b",
        grounding={"grounded": True, "max_score": 0.7},
        token_usage=None,
        created_at=datetime.now(timezone.utc),
    )


class _Scalars:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None

    def scalars(self):
        return _Scalars(self._rows)


class FakeSession:
    def __init__(self, sessions, messages=None, error: Exception | None = None):
        self._sessions = sessions
        self._messages = messages or []
        self._error = error
        self.deleted = False

    async def execute(self, stmt, *args, **kwargs):
        if self._error is not None:
            raise self._error
        if isinstance(stmt, Delete):
            self.deleted = True
            return SimpleNamespace(rowcount=1)
        if isinstance(stmt, Select):
            froms = stmt.get_final_froms() if hasattr(stmt, "get_final_froms") else stmt.froms
            table = froms[0].name  # "sessions" or "messages"
            return _Rows(self._sessions if table == "sessions" else self._messages)
        raise AssertionError(f"unexpected statement: {stmt!r}")

    async def commit(self):
        pass

    async def refresh(self, instance, **kwargs):
        pass


def _override(db):
    async def _db():
        yield db

    app.dependency_overrides[get_db] = _db


def test_rename_requires_at_least_one_field():
    with TestClient(app) as client:
        response = client.patch(f"/sessions/{SESSION_ID}", json={})
    assert response.status_code == 422


def test_rename_unknown_session_returns_404():
    _override(FakeSession([]))
    try:
        with TestClient(app) as client:
            response = client.patch(
                f"/sessions/{SESSION_ID}", json={"title": "New title"}
            )
        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_rename_updates_title_and_field_preserved():
    session = SimpleNamespace(
        id=SESSION_ID,
        title="Old title",
        user_label="label",
        meta={},
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    _override(FakeSession([session]))
    try:
        with TestClient(app) as client:
            response = client.patch(f"/sessions/{SESSION_ID}", json={"title": "New title"})
        assert response.status_code == 200
        body = response.json()
        assert body["title"] == "New title"
        assert body["user_label"] == "label"
        assert body["id"] == str(SESSION_ID)
    finally:
        app.dependency_overrides.clear()


def test_delete_unknown_session_returns_404():
    _override(FakeSession([]))
    try:
        with TestClient(app) as client:
            response = client.delete(f"/sessions/{SESSION_ID}")
        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_delete_session_returns_204():
    fake = FakeSession([SimpleNamespace(id=SESSION_ID)])
    _override(fake)
    try:
        with TestClient(app) as client:
            response = client.delete(f"/sessions/{SESSION_ID}")
        assert response.status_code == 204
        assert response.content == b""
        assert fake.deleted is True
    finally:
        app.dependency_overrides.clear()


def test_messages_unknown_session_returns_404():
    _override(FakeSession([]))
    try:
        with TestClient(app) as client:
            response = client.get(f"/sessions/{SESSION_ID}/messages")
        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_messages_returns_ordered_messages_with_telemetry():
    user = _message("user", "hello")
    assistant = _message("assistant", "hi there")
    _override(FakeSession([SimpleNamespace(id=SESSION_ID)], messages=[user, assistant]))
    try:
        with TestClient(app) as client:
            response = client.get(f"/sessions/{SESSION_ID}/messages")
        assert response.status_code == 200
        body = response.json()
        assert [m["role"] for m in body] == ["user", "assistant"]
        assert body[1]["model"] == "llama3.2:3b"
        assert body[1]["grounding"] == {"grounded": True, "max_score": 0.7}
        assert body[0]["provider"] == "ollama"
    finally:
        app.dependency_overrides.clear()


def test_rename_returns_503_when_db_unavailable():
    _override(
        FakeSession(
            [], error=OperationalError("SELECT 1", {}, Exception("db down"))
        )
    )
    try:
        with TestClient(app) as client:
            response = client.patch(f"/sessions/{SESSION_ID}", json={"title": "x"})
        assert response.status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_delete_returns_503_when_db_unavailable():
    _override(
        FakeSession(
            [], error=OperationalError("DELETE", {}, Exception("db down"))
        )
    )
    try:
        with TestClient(app) as client:
            response = client.delete(f"/sessions/{SESSION_ID}")
        assert response.status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_messages_returns_503_when_db_unavailable():
    _override(
        FakeSession(
            [], error=OperationalError("SELECT 1", {}, Exception("db down"))
        )
    )
    try:
        with TestClient(app) as client:
            response = client.get(f"/sessions/{SESSION_ID}/messages")
        assert response.status_code == 503
    finally:
        app.dependency_overrides.clear()