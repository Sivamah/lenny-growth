"""SSE chat endpoint bridging FastAPI persistence to the Node agent-service.

`POST /api/chat`:
* 404 when the session does not exist,
* persists the user message before the assistant runs,
* returns 502 when the agent-service is unreachable up front,
* otherwise streams Server-Sent Events until `turn_end`.

Each SSE frame is `event: <type>` + `data: <json>`. Event types mirror the Node
wire protocol: turn_start, text_delta, tool_start, tool_end, citations,
grounding, usage, error, turn_end.
"""
from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.node_client import AgentServiceError, NodeAgentClient
from app.agent.orchestrator import ChatOrchestrator
from app.agent.skills import effective_skill
from app.api.deps import get_db, get_node_client
from app.config import get_settings
from app.db.models import ChatSession
from app.schemas.chat import ChatRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])


def _sse_frame(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/chat")
async def chat(
    payload: ChatRequest,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    node_client: Annotated[NodeAgentClient, Depends(get_node_client)],
) -> StreamingResponse:
    settings = get_settings()

    try:
        session = await db.get(ChatSession, payload.session_id)
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database unavailable: {exc}",
        ) from exc
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found. Create one with POST /sessions first.",
        )

    orchestrator = ChatOrchestrator(db, settings, node_client)
    skill = effective_skill(payload.skill, payload.message)
    try:
        history = await orchestrator.load_history(session.id)
        await orchestrator.persist_user_message(session, payload.message, skill=skill)
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database unavailable: {exc}",
        ) from exc

    try:
        client, response = await orchestrator.open_turn(session, payload.message, history, skill)
    except AgentServiceError as exc:
        logger.warning("chat_agent_unreachable", extra={"session_id": str(session.id)})
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The assistant service is unavailable. Your message was saved; please try again.",
        ) from exc

    async def events():
        # The orchestrator owns disconnect handling: when this stream is
        # cancelled or closed by the server, we explicitly close the
        # orchestrator generator so it can abort the Node turn and persist any
        # partial assistant text (otherwise it would only be GC-finalised later
        # and the partial reply would be lost).
        gen = orchestrator.stream(client, response, session, request.is_disconnected, skill)
        try:
            async for chunk in gen:
                frame = _sse_frame(chunk.get("event", "message"), chunk.get("data", {}))
                yield frame
        finally:
            await gen.aclose()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )