"""`POST /api/chat` orchestration: persistence + NDJSON -> SSE streaming.

The orchestrator is the single place that owns:
* persisting the user message up front (so it survives agent failure),
* translating the Node agent-service NDJSON wire events into SSE-shaped chunks,
* accumulating citations / provider / model / grounding / token-usage, and
* persisting the assistant message (full, partial, or error-terminated).

On client disconnect it best-effort aborts the Node turn and persists any partial
assistant text so the session's history is never lost.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.node_client import AgentEvent, AgentServiceError, NodeAgentClient
from app.config import Settings
from app.db.models import ChatSession, Message
from app.services.content_sanitizer import sanitize_artifact

logger = logging.getLogger(__name__)

PUBLIC_TURN_ERROR = "The assistant failed to finish its reply. Your message was saved; please try again."


def provider_from_model(model_label: str | None) -> str | None:
    if not model_label or "/" not in model_label:
        return None
    return model_label.split("/", 1)[0]


def history_payload(messages: Sequence[Message], limit: int) -> list[dict[str, str]]:
    """Distilled user/assistant history for the agent-service, newest-capped."""
    selected = messages[-limit:] if limit > 0 else list(messages)
    return [
        {"role": message.role, "content": message.content}
        for message in selected
        if message.role in ("user", "assistant")
    ]


@dataclass
class TurnState:
    content_parts: list[str] = field(default_factory=list)
    citations: list[dict[str, Any]] = field(default_factory=list)
    grounding: dict[str, Any] | None = None
    model: str | None = None
    provider: str | None = None
    token_usage: dict[str, Any] | None = None
    stop_reason: str = "stop"
    error: str | None = None
    skill: str | None = None
    artifact: dict[str, Any] | None = None

    @property
    def text(self) -> str:
        return "".join(self.content_parts).strip()


class ChatOrchestrator:
    def __init__(self, db: AsyncSession, settings: Settings, client: NodeAgentClient):
        self.db = db
        self.settings = settings
        self.client = client

    async def load_history(self, session_id: uuid.UUID) -> list[Message]:
        result = await self.db.execute(
            select(Message)
            .where(Message.session_id == session_id)
            .order_by(Message.created_at.asc(), Message.id.asc())
        )
        return list(result.scalars().all())

    async def persist_user_message(self, session: ChatSession, content: str, skill: str | None = None) -> Message:
        message = Message(session_id=session.id, role="user", content=content, skill=skill)
        self.db.add(message)
        await self.db.commit()
        await self.db.refresh(message)
        return message

    async def open_turn(
        self, session: ChatSession, prompt: str, history: Sequence[Message], skill: str | None = None
    ) -> tuple[Any, Any]:
        payload = {
            "session_id": str(session.id),
            "turn_id": str(uuid.uuid4()),
            "prompt": prompt,
            "history": history_payload(history, self.settings.chat_history_max_messages),
        }
        if skill:
            payload["skill"] = skill
        logger.info(
            "chat_open_turn",
            extra={
                "session_id": str(session.id),
                "history_len": len(payload["history"]),
                "skill": skill,
            },
        )
        return await self.client.open_turn(payload)

    async def _persist_assistant(self, session: ChatSession, state: TurnState) -> Message | None:
        text = state.text
        if not text and not state.model:
            # Nothing worth persisting (e.g. an error before the model produced any text).
            return None
        message = Message(
            session_id=session.id,
            role="assistant",
            content=text,
            provider=state.provider,
            skill=state.skill,
            citations=state.citations,
            model=state.model,
            grounding=state.grounding,
            token_usage=state.token_usage,
        )
        self.db.add(message)
        await self.db.commit()
        await self.db.refresh(message)
        return message

    async def _safe_persist(self, session: ChatSession, state: TurnState) -> Message | None:
        try:
            return await self._persist_assistant(session, state)
        except Exception:  # noqa: BLE001 - persistence must never crash the stream
            logger.exception("assistant_persist_failed", extra={"session_id": str(session.id)})
            return None

    async def _safe_persist_artifact(self, session: ChatSession, message: Message, artifact_data: dict[str, Any]) -> uuid.UUID | None:
        try:
            from app.db.models import Artifact
            import re
            
            # Title extraction: prefer existing title, then <h1> for HTML, then markdown heading
            title = artifact_data.get("title")
            content = artifact_data.get("content", "")
            kind = artifact_data.get("kind", "markdown")
            if not title or title == "Generated Artifact":
                if kind == "html" or "<h1" in content.lower():
                    h1_match = re.search(r'<h1[^>]*>(.*?)</h1>', content, re.IGNORECASE | re.DOTALL)
                    if h1_match:
                        title = re.sub(r'<[^>]+>', '', h1_match.group(1)).strip()
                if not title or title == "Generated Artifact":
                    title_match = re.search(r'^\s*#+\s+(.+)$', content, re.MULTILINE)
                    if title_match:
                        title = title_match.group(1).strip()
            if not title:
                title = "Generated Artifact"

            # Untrusted model output: sanitize before persistence so the stored
            # artifact (and the streamed copy) obey the artifact security policy.
            content = sanitize_artifact(kind, content)

            artifact = Artifact(
                session_id=session.id,
                message_id=message.id,
                kind=kind,
                title=title,
                content=content,
                raw_content=content
            )
            self.db.add(artifact)
            await self.db.commit()
            await self.db.refresh(artifact)
            artifact_data["content"] = content
            artifact_data["kind"] = kind
            artifact_data["title"] = title
            return artifact.id
        except Exception:
            logger.exception("artifact_persist_failed", extra={"session_id": str(session.id)})
            return None

    async def stream(
        self,
        client: Any,
        response: Any,
        session: ChatSession,
        is_disconnected: Callable[[], Awaitable[bool]] | None = None,
        skill: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Consume NDJSON events and yield {"event": name, "data": {...}} chunks.

        `is_disconnected` (usually `request.is_disconnected`) is polled once per
        yielded chunk. On a detected disconnect — or an external cancellation /
        generator close — the Node turn is aborted and any partial assistant
        text is persisted first, so a user-triggered "Stop" never loses the
        transcript of the run so far.

        `skill` is recorded on the persisted assistant message (e.g.
        "ship30_essay"). Essay turns stream their text as a single buffered
        delta at the end, so an abort mid-essay persists nothing extra.
        """
        state = TurnState(skill=skill)
        persisted: Message | None = None

        async def finish(reason: str) -> AsyncGenerator[dict[str, Any], None]:
            nonlocal persisted
            if persisted is None:
                persisted = await self._safe_persist(session, state)
            
            if state.artifact and persisted:
                artifact_id = await self._safe_persist_artifact(session, persisted, state.artifact)
                if artifact_id:
                    yield {
                        "event": "artifact",
                        "data": {
                            "id": str(artifact_id),
                            "kind": state.artifact.get("kind"),
                            "title": state.artifact.get("title", "Generated Artifact"),
                            "content": state.artifact.get("content", ""),
                            "message_id": str(persisted.id)
                        }
                    }
            yield {
                "event": "turn_end",
                "data": {
                    "stop_reason": reason,
                    "message_id": str(persisted.id) if persisted else None,
                    "grounded": None if state.grounding is None else bool(state.grounding.get("grounded")),
                    "provider": state.provider,
                    "model": state.model,
                },
            }

        try:
            async for event in self.client.iter_events(response):
                chunk = self._consume(event, state)
                if chunk is not None:
                    yield chunk
                if is_disconnected is not None and await is_disconnected():
                    raise asyncio.CancelledError()
        except AgentServiceError as exc:
            logger.warning("agent_turn_stream_error", extra={"error": str(exc)})
            state.error = PUBLIC_TURN_ERROR
            state.stop_reason = "error"
            yield {"event": "error", "data": {"message": PUBLIC_TURN_ERROR, "retryable": True}}
        except (asyncio.CancelledError, GeneratorExit):
            # Client disconnected mid-stream (either detected by our poll or by
            # the server cancelling/closing the stream). Persist whatever partial
            # assistant text reached us. The commit is shielded so an
            # outer cancellation (starlette teardown) cannot interrupt the DB
            # write mid-commit.
            state.stop_reason = "aborted"
            logger.warning(
                "chat_stream_closed",
                extra={
                    "session_id": str(session.id),
                    "partial_chars": len(state.text),
                    "reason": "cancel-or-exit",
                },
            )
            if state.text:
                persist_task = asyncio.create_task(self._safe_persist(session, state))
                try:
                    persist_task = asyncio.shield(persist_task)
                    await persist_task
                except (asyncio.CancelledError, GeneratorExit):
                    logger.warning(
                        "chat_partial_persist_deferred",
                        extra={"session_id": str(session.id)},
                    )
            try:
                await self.client.abort(str(session.id))
            except Exception:  # noqa: BLE001 - abort is best-effort
                logger.exception("node_abort_failed", extra={"session_id": str(session.id)})
            raise
        finally:
            await self.client.close_stream(client, response)

        if state.stop_reason == "error" and not state.text:
            # Persist nothing beyond the already-saved user message.
            async for chunk in finish("error"):
                yield chunk
            return

        async for chunk in finish(state.stop_reason):
            yield chunk

    def _consume(self, event: AgentEvent, state: TurnState) -> dict[str, Any] | None:
        kind = event.get("type")
        if kind == "turn_start":
            state.model = event.get("model") or state.model
            state.provider = provider_from_model(state.model)
            return {
                "event": "turn_start",
                "data": {"model": state.model, "provider": state.provider},
            }
        if kind == "text_delta":
            text = event.get("text")
            if isinstance(text, str) and text:
                state.content_parts.append(text)
            return {"event": "text_delta", "data": {"text": text if isinstance(text, str) else ""}}
        if kind in ("tool_start", "tool_end"):
            data = {key: value for key, value in event.items() if key != "type"}
            return {"event": kind, "data": data}
        if kind == "citations":
            citations = event.get("citations")
            if isinstance(citations, list):
                state.citations = [c for c in citations if isinstance(c, dict)]
            return {"event": "citations", "data": {"citations": state.citations}}
        if kind == "grounding":
            grounded = bool(event.get("grounded"))
            max_score = event.get("maxScore")
            state.grounding = {
                "grounded": grounded,
                "max_score": max_score if isinstance(max_score, (int, float)) else None,
            }
            return {"event": "grounding", "data": dict(state.grounding)}
        if kind == "usage":
            usage = event.get("usage")
            if isinstance(usage, dict):
                state.token_usage = usage
            return {"event": "usage", "data": {"usage": state.token_usage}}
        if kind == "error":
            message = event.get("message")
            state.error = message if isinstance(message, str) else "Agent error"
            state.stop_reason = "error"
            return {
                "event": "error",
                "data": {"message": state.error, "retryable": bool(event.get("retryable"))},
            }
        if kind == "artifact":
            state.artifact = {
                "kind": event.get("kind", "markdown"),
                "content": event.get("content", ""),
                "title": event.get("title"),
            }
            return None
        if kind == "turn_end":
            reason = event.get("stop_reason")
            if isinstance(reason, str):
                state.stop_reason = reason
            return None
        return None