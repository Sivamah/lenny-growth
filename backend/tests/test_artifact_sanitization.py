"""Artifact sanitization wiring tests.

Verifies the content security policy is applied at both boundaries:

* write time  -- ``ChatOrchestrator._safe_persist_artifact`` sanitizes model
  output before it is stored (and before it is streamed back), and
* read time   -- ``GET /artifacts/{id}`` re-sanitizes on retrieval as
  defense in depth for rows persisted before the policy existed.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.agent.orchestrator import ChatOrchestrator
from app.api.deps import get_db
from app.config import get_settings
from app.main import app


class FakeWriteSession:
    def __init__(self):
        self.added: list[object] = []

    def add(self, obj):
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()
        self.added.append(obj)

    async def commit(self):
        return None

    async def refresh(self, obj):
        return None


class FakeReadSession:
    def __init__(self, artifact):
        self._artifact = artifact

    async def get(self, model, pk):
        return self._artifact

    async def execute(self, *args, **kwargs):  # pragma: no cover - not exercised
        raise AssertionError("execute not expected in this test")


def _fake_artifact(kind: str, content: str):
    return SimpleNamespace(
        id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        message_id=None,
        kind=kind,
        title="T",
        content=content,
        created_at=datetime.now(timezone.utc),
    )


async def test_write_path_sanitizes_before_persisting_and_streaming():
    db = FakeWriteSession()
    orchestrator = ChatOrchestrator(db=db, settings=get_settings(), client=None)

    session = SimpleNamespace(id=uuid.uuid4())
    message = SimpleNamespace(id=uuid.uuid4())
    artifact_data = {
        "kind": "html",
        "title": None,
        "content": "<h1>Report</h1><script>alert(1)</script><img src='x' onerror='a'>",
    }

    artifact_id = await orchestrator._safe_persist_artifact(session, message, artifact_data)

    assert artifact_id is not None
    stored = db.added[0]
    assert "<script" not in stored.content.lower()
    assert "onerror" not in stored.content.lower()
    assert "<h1>Report</h1>" in stored.content
    assert stored.raw_content == stored.content
    # The streamed copy handed back to the caller is sanitized too.
    assert artifact_data["content"] == stored.content


async def test_write_path_sanitizes_markdown_artifacts():
    db = FakeWriteSession()
    orchestrator = ChatOrchestrator(db=db, settings=get_settings(), client=None)

    artifact_data = {
        "kind": "markdown",
        "title": "Notes",
        "content": "# Notes\n\n[click](javascript:alert(1))",
    }
    await orchestrator._safe_persist_artifact(
        SimpleNamespace(id=uuid.uuid4()), SimpleNamespace(id=uuid.uuid4()), artifact_data
    )

    stored = db.added[0]
    assert "javascript:" not in stored.content.lower()
    assert stored.content.startswith("# Notes")


def test_read_path_resanitizes_legacy_html_rows():
    legacy = _fake_artifact("html", "<h2>Old</h2><script>alert(1)</script><iframe src=x></iframe>")

    async def _db():
        yield FakeReadSession(legacy)

    app.dependency_overrides[get_db] = _db
    try:
        with TestClient(app) as client:
            response = client.get(f"/artifacts/{legacy.id}")
        assert response.status_code == 200
        body = response.json()
        assert body["content"].startswith("<h2>Old</h2>")
        assert "<script" not in response.text.lower()
        assert "<iframe" not in response.text.lower()
    finally:
        app.dependency_overrides.clear()


def test_read_path_preserves_clean_artifacts():
    clean = _fake_artifact("markdown", "# Title\n\n[ok](https://example.com)")

    async def _db():
        yield FakeReadSession(clean)

    app.dependency_overrides[get_db] = _db
    try:
        with TestClient(app) as client:
            response = client.get(f"/artifacts/{clean.id}")
        assert response.status_code == 200
        assert response.json()["content"] == "# Title\n\n[ok](https://example.com)"
    finally:
        app.dependency_overrides.clear()
