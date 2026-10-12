"""HTTP boundary + NDJSON event decoding for the Node.js agent-service.

``NodeAgentClient`` speaks the agent-service's documented internal wire protocol:

    POST /v1/turn  -> Content-Type: application/x-ndjson stream of typed events
    POST /v1/abort -> best-effort cancellation of a live turn

The Node service owns the Pi agent runtime (model calls, the search_transcripts
tool loop); this client only consumes its events and forwards them as Python
dicts. Callers own closing the httpx client and response.
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.config import Settings
from app.services.agent_client import AgentServiceClient

logger = logging.getLogger(__name__)

AgentEvent = dict[str, Any]

NDJSON_HEADERS = {"Accept": "application/x-ndjson, application/json"}


class AgentServiceError(RuntimeError):
    """Raised when /v1/turn cannot be reached or rejects the request."""


class NodeAgentClient:
    def __init__(self, service: AgentServiceClient, settings: Settings):
        self._service = service
        self._settings = settings

    def _stream_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=5.0,
            read=self._settings.agent_turn_timeout_seconds,
            write=10.0,
            pool=5.0,
        )

    async def open_turn(
        self, payload: dict[str, Any]
    ) -> tuple[httpx.AsyncClient, httpx.Response]:
        """Open a streaming POST /v1/turn. Raises AgentServiceError on failure.

        Returns an open (client, response) pair; the caller closes both.
        """
        client = httpx.AsyncClient(timeout=self._stream_timeout())
        try:
            request = client.build_request(
                "POST",
                self._service.turn_url(),
                json=payload,
                headers={**self._service.headers(), **NDJSON_HEADERS},
            )
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            logger.warning(
                "agent_turn_unreachable", extra={"error": str(exc)}
            )
            await client.aclose()
            raise AgentServiceError(
                f"Agent-service unreachable at {self._service.base_url}"
            ) from exc

        if response.status_code != 200:
            detail = ""
            try:
                detail = (await response.aread()).decode("utf-8", errors="replace")[:300]
            except httpx.HTTPError:
                pass
            await response.aclose()
            await client.aclose()
            raise AgentServiceError(
                f"Agent-service rejected the turn with HTTP {response.status_code}: {detail}"
            )
        return client, response

    async def iter_events(self, response: httpx.Response) -> AsyncIterator[AgentEvent]:
        """Yield each non-empty NDJSON line that decodes to a typed event object."""
        async for line in response.aiter_lines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and isinstance(event.get("type"), str):
                yield event

    async def abort(self, session_id: str) -> None:
        """Best-effort abort of a live turn. Never raises."""
        try:
            async with httpx.AsyncClient(
                timeout=min(self._settings.agent_turn_timeout_seconds, 15.0)
            ) as client:
                await client.post(
                    self._service.abort_url(),
                    json={"session_id": session_id},
                    headers=self._service.headers(),
                )
        except httpx.HTTPError as exc:  # noqa: BLE001 - abort is best-effort
            logger.warning("agent_abort_failed", extra={"error": str(exc)})

    async def close_stream(self, client: httpx.AsyncClient, response: httpx.Response) -> None:
        try:
            await response.aclose()
        except httpx.HTTPError:
            pass
        await client.aclose()