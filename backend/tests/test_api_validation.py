"""API validation and DB-failure handling tests.

Request validation (422) happens before any database access, so those tests run
without PostgreSQL. The 503 test overrides the DB dependency with a session stub
that raises, proving the route degrades instead of crashing — still no real DB.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.api.deps import get_db
from app.main import app


def test_create_session_rejects_overlong_title():
    with TestClient(app) as client:
        response = client.post("/sessions", json={"title": "x" * 201})
    assert response.status_code == 422
    assert "detail" in response.json()


def test_create_session_rejects_invalid_meta_type():
    with TestClient(app) as client:
        response = client.post("/sessions", json={"meta": "not-an-object"})
    assert response.status_code == 422


def test_get_session_rejects_invalid_uuid():
    with TestClient(app) as client:
        response = client.get("/sessions/not-a-uuid")
    assert response.status_code == 422


def test_list_sessions_returns_503_when_db_unavailable():
    class _BrokenSession:
        async def execute(self, *args, **kwargs):
            raise OperationalError("SELECT 1", {}, Exception("db down"))

    async def _broken_db():
        yield _BrokenSession()

    app.dependency_overrides[get_db] = _broken_db
    try:
        with TestClient(app) as client:
            response = client.get("/sessions")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 503
    assert response.json()["error"]["code"] == 503


def test_root_reports_service_metadata():
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert response.json()["docs"] == "/docs"
