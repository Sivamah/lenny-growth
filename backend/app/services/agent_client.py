"""HTTP boundary to the existing Node.js Pi agent-service.

This is configuration + a thin probe only. The agent runtime (Pi SDK, Ollama
model calls, the search_transcripts tool loop) stays entirely in Node; this
client just knows how to reach it and which shared-secret header to send.

Documented internal interface (see agent-service/README.md):
    GET    /v1/health          -> service + provider status
    POST   /v1/turn            -> NDJSON event stream
    POST   /v1/abort           -> abort a live turn
    DELETE /v1/sessions/{id}   -> drop a pooled session
All /v1/* routes require `X-Internal-Token` when the service has INTERNAL_TOKEN set.
"""
from __future__ import annotations

from app.config import Settings

INTERNAL_TOKEN_HEADER = "X-Internal-Token"


class AgentServiceClient:
    def __init__(self, settings: Settings):
        self._settings = settings
        self.base_url = settings.agent_service_url.rstrip("/")

    def headers(self) -> dict[str, str]:
        """Headers for every call to the agent-service."""
        headers = {"Accept": "application/json"}
        if self._settings.internal_token:
            headers[INTERNAL_TOKEN_HEADER] = self._settings.internal_token
        return headers

    def health_url(self) -> str:
        return f"{self.base_url}/v1/health"

    def turn_url(self) -> str:
        return f"{self.base_url}/v1/turn"

    def abort_url(self) -> str:
        return f"{self.base_url}/v1/abort"

    def session_url(self, session_id: str) -> str:
        return f"{self.base_url}/v1/sessions/{session_id}"

    async def health(self) -> bool:
        """Best-effort reachability probe. Never raises."""
        import httpx

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.agent_request_timeout_seconds
            ) as client:
                response = await client.get(self.health_url(), headers=self.headers())
                return response.status_code == 200
        except Exception:  # noqa: BLE001 - probe must never propagate
            return False
