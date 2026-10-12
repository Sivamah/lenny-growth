"""Internal retrieval endpoint tests.

No live database, Ollama, or agent-service: the DB and embedder dependencies
are overridden with fakes. This exercises request validation, internal auth,
error mapping (503), empty results, and the success shape.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.api.deps import get_db, get_embedder
from app.config import get_settings
from app.main import app
from app.services.embeddings import EmbeddingError
import pytest

DIM = 768


class StubEmbedder:
    def __init__(self, vector: list[float] | None = None, error: Exception | None = None):
        self._vector = vector if vector is not None else [0.1] * DIM
        self._error = error

    async def embed_one(self, text: str) -> list[float]:
        if self._error is not None:
            raise self._error
        return self._vector


class _Mappings:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return _Mappings(self._rows)


class FakeSession:
    def __init__(self, rows=None, error: Exception | None = None):
        self._rows = rows or []
        self._error = error

    async def execute(self, *args, **kwargs):
        if self._error is not None:
            raise self._error
        return _Result(self._rows)


def _override(db, embedder):
    async def _db():
        yield db

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_embedder] = lambda: embedder


def _row(score: float = 0.82) -> dict:
    return {
        "chunk_id": "c1",
        "chunk_index": 0,
        "content": "Retention is the key growth lever.",
        "start_timestamp": "00:12:30",
        "transcript_slug": "jason-cohen",
        "episode_title": "5 questions to ask when your product stops growing",
        "guest": "Jason Cohen",
        "source_url": "https://www.lennyspodcast.com/episodes/jason-cohen",
        "score": score,
    }


@pytest.fixture
def auth_headers():
    token = get_settings().internal_token
    return {"X-Internal-Token": token} if token else {}


def test_validation_rejects_empty_query_and_bad_top_k(auth_headers):
    with TestClient(app) as client:
        assert client.post("/internal/retrieve", json={"query": ""}, headers=auth_headers).status_code == 422
        assert client.post("/internal/retrieve", json={}, headers=auth_headers).status_code == 422
        assert (
            client.post("/internal/retrieve", json={"query": "hi", "top_k": 0}, headers=auth_headers).status_code == 422
        )
        assert (
            client.post("/internal/retrieve", json={"query": "hi", "top_k": 999}, headers=auth_headers).status_code == 422
        )


def test_missing_or_wrong_internal_token_is_rejected(monkeypatch):
    monkeypatch.setenv("INTERNAL_TOKEN", "secret")
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            assert client.post("/internal/retrieve", json={"query": "hi"}).status_code == 401
            wrong = client.post(
                "/internal/retrieve",
                json={"query": "hi"},
                headers={"X-Internal-Token": "nope"},
            )
            assert wrong.status_code == 401
    finally:
        get_settings.cache_clear()


def test_correct_internal_token_is_accepted(monkeypatch):
    monkeypatch.setenv("INTERNAL_TOKEN", "secret")
    get_settings.cache_clear()
    _override(FakeSession([]), StubEmbedder())
    try:
        with TestClient(app) as client:
            response = client.post(
                "/internal/retrieve",
                json={"query": "hi"},
                headers={"X-Internal-Token": "secret"},
            )
        assert response.status_code == 200
    finally:
        app.dependency_overrides.clear()
        get_settings.cache_clear()


def test_empty_results_is_grounded_false(auth_headers):
    _override(FakeSession([]), StubEmbedder())
    try:
        with TestClient(app) as client:
            response = client.post("/internal/retrieve", json={"query": "unknown topic"}, headers=auth_headers)
        assert response.status_code == 200
        body = response.json()
        assert body["results"] == []
        assert body["grounded"] is False
        assert body["max_score"] == 0.0
        assert body["source"] == "fastapi"
    finally:
        app.dependency_overrides.clear()


def test_success_returns_citable_chunks_and_grounded_true(auth_headers):
    _override(FakeSession([_row(score=0.82)]), StubEmbedder())
    try:
        with TestClient(app) as client:
            response = client.post("/internal/retrieve", json={"query": "retention", "top_k": 3}, headers=auth_headers)
        assert response.status_code == 200
        body = response.json()
        assert body["grounded"] is True
        assert body["max_score"] == 0.82
        result = body["results"][0]
        assert result["transcript_slug"] == "jason-cohen"
        assert result["guest"] == "Jason Cohen"
        assert result["timestamp"] == "00:12:30"
        assert result["source_url"].startswith("https://")
    finally:
        app.dependency_overrides.clear()


def test_low_score_is_not_grounded(auth_headers):
    _override(FakeSession([_row(score=0.10)]), StubEmbedder())
    try:
        with TestClient(app) as client:
            response = client.post("/internal/retrieve", json={"query": "something"}, headers=auth_headers)
        assert response.status_code == 200
        assert response.json()["grounded"] is False
    finally:
        app.dependency_overrides.clear()


def test_embedding_failure_returns_503_without_leaking_details(auth_headers):
    _override(FakeSession([]), StubEmbedder(error=EmbeddingError("secret internal path /x")))
    try:
        with TestClient(app) as client:
            response = client.post("/internal/retrieve", json={"query": "hi"}, headers=auth_headers)
        assert response.status_code == 503
        assert response.json()["error"]["message"] == "Embedding service unavailable"
        assert "secret internal path" not in response.text
    finally:
        app.dependency_overrides.clear()


def test_database_error_returns_503(auth_headers):
    _override(
        FakeSession(error=OperationalError("SELECT", {}, Exception("db down"))),
        StubEmbedder(),
    )
    try:
        with TestClient(app) as client:
            response = client.post("/internal/retrieve", json={"query": "hi"}, headers=auth_headers)
        assert response.status_code == 503
        assert response.json()["error"]["message"] == "Database unavailable"
    finally:
        app.dependency_overrides.clear()
