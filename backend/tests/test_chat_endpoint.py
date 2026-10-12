"""POST /api/chat orchestration tests.

DB-free: `get_db` and `get_node_client` are overridden. The fake DB session
satisfies the subset of SQLAlchemy API the orchestrator uses (get/execute/add/
commit/refresh); the fake Node client scripts /v1/turn NDJSON events or an
unreachable / down-stream failure. Asserts validation (422), session 404,
agent-unavailable 502, and full SSE streaming with user+assistant persistence.
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.agent.node_client import AgentServiceError
from app.api.deps import get_db, get_node_client
from app.db.models import Message
from app.main import app

SESSION_ID = uuid.uuid4()

SAMPLE_EVENTS = [
    {"type": "turn_start", "model": "ollama/llama3.2:3b"},
    {"type": "text_delta", "text": "Retention "},
    {"type": "text_delta", "text": "matters."},
    {"type": "tool_start", "name": "search_transcripts", "args": {"query": "retention"}},
    {"type": "tool_end", "name": "search_transcripts", "isError": False, "durationMs": 400},
    {
        "type": "citations",
        "citations": [
            {"guest": "Jason Cohen", "episode": "Grow", "score": 0.72, "url": "https://x"}
        ],
    },
    {"type": "grounding", "grounded": True, "maxScore": 0.72},
    {"type": "turn_end", "stop_reason": "stop"},
]


class _Scalars:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return _Scalars(self._rows)


class FakeStream:
    def __init__(self, events):
        self._events = events

    async def aiter_lines(self):
        for event in self._events:
            yield json.dumps(event)


class FakeNodeClient:
    def __init__(self, events=None, unreachable=False, mid_stream_error=False):
        self._events = events or []
        self.unreachable = unreachable
        self.mid_stream_error = mid_stream_error
        self.payloads: list[dict] = []
        self.aborts: list[str] = []
        self.closed = 0

    async def open_turn(self, payload):
        if self.unreachable:
            raise AgentServiceError("Agent-service unreachable")
        self.payloads.append(payload)
        return SimpleNamespace(), FakeStream(self._events)

    async def iter_events(self, response):
        async for line in response.aiter_lines():
            yield json.loads(line)
        if self.mid_stream_error:
            raise AgentServiceError("Agent-service became unavailable mid-turn.")

    async def close_stream(self, client, response):
        self.closed += 1

    async def abort(self, session_id):
        self.aborts.append(session_id)


class FakeDb:
    def __init__(self, session, messages=None, get_error=None):
        self.session = session  # None means "session not found"
        self.messages = messages or []
        self.get_error = get_error
        self.added: list[object] = []
        self.commits = 0

    async def get(self, model, session_id):
        if self.get_error is not None:
            raise self.get_error
        return self.session

    async def execute(self, stmt, *args, **kwargs):
        return _Rows(self.messages)

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.commits += 1

    async def refresh(self, obj, **kwargs):
        pass


def _override(db, node):
    async def _db():
        yield db

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_node_client] = lambda: node


def _session():
    return SimpleNamespace(id=SESSION_ID)


def _user_and_assistant(db) -> tuple[Message, Message]:
    roles = {m.role for m in db.added}
    assert roles == {"user", "assistant"}
    return (
        next(m for m in db.added if m.role == "user"),
        next(m for m in db.added if m.role == "assistant"),
    )


def test_chat_validates_request_body():
    _override(FakeDb(_session()), FakeNodeClient())
    try:
        with TestClient(app) as client:
            assert client.post("/api/chat", json={}).status_code == 422
            assert client.post("/api/chat", json={"session_id": str(SESSION_ID)}).status_code == 422
            assert (
                client.post(
                    "/api/chat", json={"session_id": str(SESSION_ID), "message": ""}
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/chat", json={"session_id": str(SESSION_ID), "message": "   "}
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/chat", json={"session_id": "nope", "message": "hi"}
                ).status_code
                == 422
            )
    finally:
        app.dependency_overrides.clear()


def test_chat_unknown_session_returns_404():
    _override(FakeDb(None), FakeNodeClient())
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat", json={"session_id": str(SESSION_ID), "message": "hi"}
            )
        assert response.status_code == 404
        assert "Session not found" in response.json()["error"]["message"]
    finally:
        app.dependency_overrides.clear()


def test_chat_agent_unreachable_returns_502_and_warns_nothing_sensitive():
    _override(FakeDb(_session()), FakeNodeClient(unreachable=True))
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat", json={"session_id": str(SESSION_ID), "message": "hi"}
            )
        assert response.status_code == 502
        body = response.text
        assert "Agent service" not in body or "unavailable" in body
        assert "dev-internal" not in body and "/v1/turn" not in body
    finally:
        app.dependency_overrides.clear()


def test_chat_streams_sse_and_persists_user_and_assistant():
    db = FakeDb(_session())
    node = FakeNodeClient(events=SAMPLE_EVENTS)
    _override(db, node)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat", json={"session_id": str(SESSION_ID), "message": "hi"}
            )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        text = response.text
        assert "event: turn_start" in text
        assert "event: text_delta" in text and "Retention " in text
        assert "event: citations" in text
        assert "event: grounding" in text
        assert "event: turn_end" in text
        assert '"stop_reason": "stop"' in text
    finally:
        app.dependency_overrides.clear()

    assert len(db.added) == 2
    user, assistant = _user_and_assistant(db)
    assert user.role == "user"
    assert user.content == "hi"
    assert assistant.content == "Retention matters."
    assert assistant.provider == "ollama"
    assert assistant.model == "ollama/llama3.2:3b"
    assert assistant.grounding == {"grounded": True, "max_score": 0.72}
    assert assistant.citations[0]["guest"] == "Jason Cohen"


def test_chat_sends_user_history_in_turn_payload():
    prior = Message(role="user", content="Earlier question", session_id=SESSION_ID)
    db = FakeDb(_session(), messages=[prior])
    node = FakeNodeClient(events=SAMPLE_EVENTS)
    _override(db, node)
    try:
        with TestClient(app) as client:
            client.post("/api/chat", json={"session_id": str(SESSION_ID), "message": "followup"}).raise_for_status()
    finally:
        app.dependency_overrides.clear()

    assert len(node.payloads) == 1
    payload = node.payloads[0]
    assert payload["session_id"] == str(SESSION_ID)
    assert payload["prompt"] == "followup"
    assert payload["history"] == [{"role": "user", "content": "Earlier question"}]
    assert "skill" not in payload


def test_chat_ship30_keyword_forwards_skill_and_persists_it():
    db = FakeDb(_session())
    node = FakeNodeClient(events=SAMPLE_EVENTS)
    _override(db, node)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat",
                json={
                    "session_id": str(SESSION_ID),
                    "message": "Turn what we discussed into a Ship 30 essay about retention",
                },
            )
        assert response.status_code == 200
    finally:
        app.dependency_overrides.clear()

    assert node.payloads[0]["skill"] == "ship30_essay"
    user, assistant = _user_and_assistant(db)
    assert user.skill == "ship30_essay"
    assert assistant.skill == "ship30_essay"
    assert assistant.content == "Retention matters."


def test_chat_explicit_skill_field_wins_over_message():
    db = FakeDb(_session())
    node = FakeNodeClient(events=SAMPLE_EVENTS)
    _override(db, node)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat",
                json={
                    "session_id": str(SESSION_ID),
                    "message": "tell me about pricing",
                    "skill": "ship30_essay",
                },
            )
        assert response.status_code == 200
    finally:
        app.dependency_overrides.clear()

    assert node.payloads[0]["skill"] == "ship30_essay"
    user, assistant = _user_and_assistant(db)
    assert user.skill == "ship30_essay"
    assert assistant.skill == "ship30_essay"


def test_chat_weird_skill_values_are_ignored():
    db = FakeDb(_session())
    node = FakeNodeClient(events=SAMPLE_EVENTS)
    _override(db, node)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat",
                json={
                    "session_id": str(SESSION_ID),
                    "message": "essay formatting lessons from the podcast are interesting",
                    "skill": "not-a-real-skill",
                },
            )
        assert response.status_code == 200
    finally:
        app.dependency_overrides.clear()

    assert "skill" not in node.payloads[0]
    user, assistant = _user_and_assistant(db)
    assert user.skill is None
    assert assistant.skill is None


def test_chat_error_event_emits_error_and_persists_partial():
    events = [
        {"type": "turn_start", "model": "ollama/llama3.2:3b"},
        {"type": "text_delta", "text": "partial answer"},
        {"type": "error", "message": "model blew up", "retryable": True},
        {"type": "turn_end", "stop_reason": "error"},
    ]
    db = FakeDb(_session())
    node = FakeNodeClient(events=events)
    _override(db, node)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat", json={"session_id": str(SESSION_ID), "message": "hi"}
            )
        assert response.status_code == 200
        assert "event: error" in response.text
        assert '"stop_reason": "error"' in response.text
    finally:
        app.dependency_overrides.clear()

    assistant = next(m for m in db.added if m.role == "assistant")
    assert assistant.content == "partial answer"


def test_chat_agent_down_mid_stream_is_error_and_persists_partial():
    events = [
        {"type": "turn_start", "model": "ollama/llama3.2:3b"},
        {"type": "text_delta", "text": "half an answer"},
    ]
    db = FakeDb(_session())
    node = FakeNodeClient(events=events, mid_stream_error=True)
    _override(db, node)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat", json={"session_id": str(SESSION_ID), "message": "hi"}
            )
        assert response.status_code == 200
        assert "event: error" in response.text
        assert '"stop_reason": "error"' in response.text
    finally:
        app.dependency_overrides.clear()

    assistant = next(m for m in db.added if m.role == "assistant")
    assert assistant.content == "half an answer"


def test_chat_database_failure_returns_503():
    _override(
        FakeDb(None, get_error=OperationalError("SELECT 1", {}, Exception("db down"))),
        FakeNodeClient(),
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/chat", json={"session_id": str(SESSION_ID), "message": "hi"}
            )
        assert response.status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_provider_from_model_and_history_payload():
    from app.agent.orchestrator import history_payload, provider_from_model

    assert provider_from_model("ollama/llama3.2:3b") == "ollama"
    assert provider_from_model("llama3.2:3b") is None
    assert history_payload([], 10) == []

    user = Message(role="user", content="a", session_id=SESSION_ID)
    assistant = Message(role="assistant", content="b", session_id=SESSION_ID)
    system = Message(role="system", content="sys", session_id=SESSION_ID)
    assert history_payload([user, assistant, system], 10) == [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
    ]
    assert len(history_payload([user, assistant], 1)) == 1


async def test_orchestrator_persists_partial_and_aborts_node_turn_on_disconnect():
    """A client stopping mid-stream must abort the Node turn and keep the
    partial assistant text so the stop is visible in persisted history."""
    import asyncio

    from app.agent.orchestrator import ChatOrchestrator
    from app.config import Settings

    events = [
        {"type": "turn_start", "model": "ollama/llama3.2:3b"},
        {"type": "text_delta", "text": "partial"},
    ]
    db = FakeDb(_session())
    node = FakeNodeClient(events=events)
    orch = ChatOrchestrator(db, Settings(), node)
    client, response = await orch.open_turn(_session(), "prompt", [])
    disconnect_calls = 0

    async def is_disconnected():
        nonlocal disconnect_calls
        disconnect_calls += 1
        # False while the first chunk streams, True on the second poll
        # (i.e. after the partial text_delta reached the client).
        return disconnect_calls >= 2

    chunks = []
    with pytest.raises(asyncio.CancelledError):
        async for chunk in orch.stream(client, response, _session(), is_disconnected):
            chunks.append(chunk)

    assert [c["event"] for c in chunks] == ["turn_start", "text_delta"]
    assert node.aborts == [str(SESSION_ID)]
    assert node.closed == 1
    assistant = next(m for m in db.added if m.role == "assistant")
    assert assistant.content == "partial"