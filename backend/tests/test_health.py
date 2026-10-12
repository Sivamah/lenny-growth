"""Health endpoint tests (no live database or agent-service required)."""
from __future__ import annotations

from fastapi.testclient import TestClient

import app.api.routes.health as health_module
from app.api.deps import get_agent_client
from app.main import app


class _StubAgentClient:
    base_url = "http://stub-agent"

    def __init__(self, reachable: bool):
        self._reachable = reachable

    async def health(self) -> bool:
        return self._reachable


def _run_health(monkeypatch, *, db_ok: bool, agent_ok: bool):
    async def fake_check_database():
        return (db_ok, None if db_ok else "connection refused")

    monkeypatch.setattr(health_module, "check_database", fake_check_database)
    app.dependency_overrides[get_agent_client] = lambda: _StubAgentClient(agent_ok)
    try:
        with TestClient(app) as client:
            return client.get("/health")
    finally:
        app.dependency_overrides.clear()


def test_health_ok_when_all_dependencies_reachable(monkeypatch):
    response = _run_health(monkeypatch, db_ok=True, agent_ok=True)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["app_name"]
    assert body["version"]
    deps = {dep["name"]: dep for dep in body["dependencies"]}
    assert deps["database"]["reachable"] is True
    assert deps["agent_service"]["reachable"] is True


def test_health_degrades_without_crashing_when_db_down(monkeypatch):
    response = _run_health(monkeypatch, db_ok=False, agent_ok=True)
    assert response.status_code == 200  # must never 500
    body = response.json()
    assert body["status"] == "degraded"
    deps = {dep["name"]: dep for dep in body["dependencies"]}
    assert deps["database"]["reachable"] is False
    assert "connection refused" in (deps["database"]["detail"] or "")


def test_health_degrades_when_agent_service_down(monkeypatch):
    response = _run_health(monkeypatch, db_ok=True, agent_ok=False)
    assert response.status_code == 200
    assert response.json()["status"] == "degraded"


def test_health_never_raises_when_probe_errors(monkeypatch):
    async def boom():
        raise RuntimeError("unexpected probe failure")

    monkeypatch.setattr(health_module, "check_database", boom)
    app.dependency_overrides[get_agent_client] = lambda: _StubAgentClient(True)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get("/health")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 500  # handled gracefully, not a crash/traceback leak
    assert response.json()["error"]["code"] == 500
