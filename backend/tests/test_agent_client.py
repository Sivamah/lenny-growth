"""Agent-service boundary client tests (configuration + probe, no DB)."""
from __future__ import annotations

from app.config import Settings
from app.services.agent_client import INTERNAL_TOKEN_HEADER, AgentServiceClient


def test_base_url_trailing_slash_normalized():
    settings = Settings(_env_file=None, agent_service_url="http://host:9000/")
    assert AgentServiceClient(settings).base_url == "http://host:9000"


def test_internal_token_header_present_when_configured():
    settings = Settings(
        _env_file=None, internal_token="shared-secret", agent_service_url="http://host:9000"
    )
    headers = AgentServiceClient(settings).headers()
    assert headers[INTERNAL_TOKEN_HEADER] == "shared-secret"


def test_internal_token_header_absent_when_unset():
    settings = Settings(_env_file=None)
    assert INTERNAL_TOKEN_HEADER not in AgentServiceClient(settings).headers()


def test_endpoint_builders_use_documented_interface():
    client = AgentServiceClient(Settings(_env_file=None, agent_service_url="http://host:8001"))
    assert client.health_url() == "http://host:8001/v1/health"
    assert client.turn_url() == "http://host:8001/v1/turn"
    assert client.abort_url() == "http://host:8001/v1/abort"
    assert client.session_url("abc") == "http://host:8001/v1/sessions/abc"


async def test_health_probe_returns_false_when_unreachable():
    settings = Settings(
        _env_file=None,
        agent_service_url="http://127.0.0.1:1",
        agent_request_timeout_seconds=1.0,
    )
    assert await AgentServiceClient(settings).health() is False
