"""Reusable FastAPI dependencies."""
from __future__ import annotations

from fastapi import Request

from app.config import get_settings
from app.db.session import get_db  # re-exported for routers
from app.agent.node_client import NodeAgentClient
from app.services.agent_client import AgentServiceClient
from app.services.embeddings import EmbeddingService

__all__ = ["get_db", "get_agent_client", "get_embedder", "get_node_client"]


def get_agent_client(request: Request) -> AgentServiceClient:
    """Return the shared agent-service client, creating it on first use."""
    client = getattr(request.app.state, "agent_client", None)
    if client is None:
        client = AgentServiceClient(get_settings())
        request.app.state.agent_client = client
    return client


def get_embedder(request: Request) -> EmbeddingService:
    """Return the shared Ollama embedding service, creating it on first use."""
    embedder = getattr(request.app.state, "embedder", None)
    if embedder is None:
        embedder = EmbeddingService(get_settings())
        request.app.state.embedder = embedder
    return embedder


def get_node_client(request: Request) -> NodeAgentClient:
    """Return the shared Node agent-service streaming client, creating it on first use."""
    client = getattr(request.app.state, "node_client", None)
    if client is None:
        client = NodeAgentClient(get_agent_client(request), get_settings())
        request.app.state.node_client = client
    return client
