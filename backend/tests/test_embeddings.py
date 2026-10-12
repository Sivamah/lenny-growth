"""Embedding service tests. These use a mocked HTTP transport — no live Ollama.

A real embedding is either produced and validated, or an EmbeddingError is
raised. The deterministic helper is only used to fabricate vectors for tests.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings
from app.services.embeddings import (
    EmbeddingError,
    EmbeddingService,
    deterministic_test_embedding,
)

DIM = 768
MODEL = "nomic-embed-text"


def _settings(**overrides) -> Settings:
    base = dict(
        _env_file=None,
        ollama_base_url="http://test-ollama",
        ollama_embedding_model=MODEL,
        embedding_dimensions=DIM,
        embedding_timeout_seconds=5.0,
    )
    base.update(overrides)
    return Settings(**base)


def _service(handler, **overrides) -> EmbeddingService:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return EmbeddingService(_settings(**overrides), client=client)


async def test_embed_batches_and_returns_vectors():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/embed"
        body = json.loads(request.content)
        assert body["model"] == MODEL
        return httpx.Response(200, json={"embeddings": [[0.1] * DIM for _ in body["input"]]})

    service = _service(handler)
    vectors = await service.embed(["alpha", "beta", "gamma"])
    assert len(vectors) == 3
    assert all(len(v) == DIM for v in vectors)


async def test_embed_empty_input_short_circuits():
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("no HTTP call expected for empty input")

    assert await _service(handler).embed([]) == []


async def test_dimension_mismatch_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.1] * 512]})

    with pytest.raises(EmbeddingError, match="dimension mismatch"):
        await _service(handler).embed(["alpha"])


async def test_vector_count_mismatch_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.1] * DIM]})

    with pytest.raises(EmbeddingError, match="unexpected number of vectors"):
        await _service(handler).embed(["alpha", "beta"])


async def test_malformed_json_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not-json", headers={"content-type": "application/json"})

    with pytest.raises(EmbeddingError, match="malformed JSON"):
        await _service(handler).embed(["alpha"])


async def test_empty_vector_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[]]})

    with pytest.raises(EmbeddingError, match="empty vector"):
        await _service(handler).embed(["alpha"])


async def test_non_numeric_values_raise():
    def handler(request: httpx.Request) -> httpx.Response:
        vector = [0.0] * DIM
        vector[0] = "not-a-number"
        return httpx.Response(200, json={"embeddings": [vector]})

    with pytest.raises(EmbeddingError, match="non-numeric"):
        await _service(handler).embed(["alpha"])


async def test_http_error_status_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with pytest.raises(EmbeddingError, match="HTTP 500"):
        await _service(handler).embed(["alpha"])


async def test_timeout_raises_embedding_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    with pytest.raises(EmbeddingError, match="timed out"):
        await _service(handler).embed(["alpha"])


async def test_connection_error_raises_embedding_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(EmbeddingError, match="failed"):
        await _service(handler).embed(["alpha"])


async def test_is_available_true_on_200():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/tags"
        return httpx.Response(200, json={"models": []})

    assert await _service(handler).is_available() is True


async def test_is_available_false_on_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope", request=request)

    assert await _service(handler).is_available() is False


def test_deterministic_test_embedding_is_stable_and_normalized():
    first = deterministic_test_embedding("growth loops and retention", 64)
    second = deterministic_test_embedding("growth loops and retention", 64)
    assert first == second
    assert len(first) == 64
    norm = sum(v * v for v in first) ** 0.5
    assert abs(norm - 1.0) < 1e-6
    # clearly-labelled test-only helper; not semantic, but different text differs
    other = deterministic_test_embedding("pricing strategy", 64)
    assert other != first
