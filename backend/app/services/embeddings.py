"""Embedding generation via the local Ollama embedding model.

Uses Ollama's batch endpoint (verified against Ollama on this machine):

    POST {base}/api/embed
    {"model": "nomic-embed-text", "input": ["...", "..."]}
    -> {"embeddings": [[... 768 floats ...], ...], ...}

Design rules:

* Embeddings are **real** semantic vectors or the call fails. We never silently
  substitute a synthetic vector for a failed real embedding in production — a
  hash fallback can make retrieval look like it works while returning
  meaningless neighbours. Failures raise :class:`EmbeddingError`.
* Every response is validated: the number of vectors must match the number of
  inputs, and each vector's dimension must match the configured
  ``embedding_dimensions`` before it is ever written to the database.
* ``deterministic_test_embedding`` exists for isolated unit tests only. It is
  explicitly named, documented, and never referenced by production code paths.
"""
from __future__ import annotations

import hashlib
import logging
import math

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


class EmbeddingError(RuntimeError):
    """Raised when a real embedding cannot be produced or validated."""


def deterministic_test_embedding(text: str, dimensions: int) -> list[float]:
    """A deterministic bag-of-hashed-tokens vector for UNIT TESTS ONLY.

    This is **not** a semantic embedding and must never be used for real
    retrieval. It exists so tests can exercise storage/ranking code without a
    live Ollama instance. Production code paths raise :class:`EmbeddingError`
    instead of calling this.
    """
    vector = [0.0] * dimensions
    for token in text.lower().split():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[index] += sign
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


class EmbeddingService:
    def __init__(self, settings: Settings, *, client: httpx.AsyncClient | None = None):
        self.base_url = settings.ollama_base_url.rstrip("/")
        self.model = settings.ollama_embedding_model
        self.dimensions = settings.embedding_dimensions
        self.timeout = settings.embedding_timeout_seconds
        self._batch_size = 64
        self._client = client

    def _embed_url(self) -> str:
        return f"{self.base_url}/api/embed"

    async def _client_scope(self) -> httpx.AsyncClient:
        if self._client is not None:
            return self._client
        return httpx.AsyncClient(timeout=self.timeout)

    async def is_available(self) -> bool:
        """Best-effort reachability probe. Never raises."""
        try:
            client = await self._client_scope()
            try:
                response = await client.get(f"{self.base_url}/api/tags", timeout=5.0)
                return response.status_code == 200
            finally:
                if self._client is None:
                    await client.aclose()
        except Exception:  # noqa: BLE001 - probe must never propagate
            return False

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed ``texts`` in order. Raises EmbeddingError on any failure."""
        if not texts:
            return []

        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = texts[start : start + self._batch_size]
            vectors.extend(await self._embed_batch(batch))
        return vectors

    async def embed_one(self, text: str) -> list[float]:
        vectors = await self.embed([text])
        if not vectors:
            raise EmbeddingError("embedding service returned no vector")
        return vectors[0]

    async def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        payload = {"model": self.model, "input": batch}
        try:
            client = await self._client_scope()
            try:
                response = await client.post(self._embed_url(), json=payload)
            finally:
                if self._client is None:
                    await client.aclose()
        except httpx.TimeoutException as exc:
            raise EmbeddingError(
                f"embedding request to {self._embed_url()} timed out after "
                f"{self.timeout}s (model={self.model})"
            ) from exc
        except httpx.HTTPError as exc:
            raise EmbeddingError(
                f"embedding request to {self._embed_url()} failed: {exc}"
            ) from exc

        if response.status_code != 200:
            raise EmbeddingError(
                f"embedding endpoint returned HTTP {response.status_code} "
                f"(model={self.model})"
            )

        try:
            data = response.json()
        except ValueError as exc:
            raise EmbeddingError("embedding endpoint returned malformed JSON") from exc

        embeddings = data.get("embeddings") if isinstance(data, dict) else None
        if not isinstance(embeddings, list) or len(embeddings) != len(batch):
            raise EmbeddingError(
                "embedding endpoint returned an unexpected number of vectors "
                f"(expected {len(batch)}, got "
                f"{len(embeddings) if isinstance(embeddings, list) else 'none'})"
            )

        return [self._validate_vector(vector) for vector in embeddings]

    def _validate_vector(self, vector: object) -> list[float]:
        if not isinstance(vector, list) or not vector:
            raise EmbeddingError("embedding endpoint returned an empty vector")
        if len(vector) != self.dimensions:
            raise EmbeddingError(
                f"embedding dimension mismatch: model {self.model!r} returned "
                f"{len(vector)} dims but EMBEDDING_DIMENSIONS is {self.dimensions}"
            )
        try:
            return [float(value) for value in vector]
        except (TypeError, ValueError) as exc:
            raise EmbeddingError("embedding vector contained non-numeric values") from exc
