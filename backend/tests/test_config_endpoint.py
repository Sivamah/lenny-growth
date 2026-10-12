"""Public config endpoint tests (pure — no database or agent-service needed)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_config_returns_public_settings():
    with TestClient(app) as client:
        response = client.get("/api/config")
    assert response.status_code == 200
    body = response.json()
    assert body["app_name"]
    assert body["version"]
    assert body["environment"]
    assert body["chat_max_message_chars"] == 8000
    assert isinstance(body["retrieval_top_k"], int) and body["retrieval_top_k"] > 0
    assert isinstance(body["retrieval_min_score"], float)


def test_config_matches_chat_input_limit():
    with TestClient(app) as client:
        body = client.get("/api/config").json()
    assert body["chat_max_message_chars"] == 8000
    too_long = "x" * 8001
    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            json={"session_id": "00000000-0000-0000-0000-000000000000", "message": too_long},
        )
    assert response.status_code == 422