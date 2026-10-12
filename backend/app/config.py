"""Central runtime configuration.

Every knob an operator may need to change (database location, agent-service URL,
shared secret, retrieval sizing) is an environment variable read here and
nowhere else. See `.env.example` for the full, commented list.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App -----------------------------------------------------------------
    app_name: str = Field(default="Lenny Growth Assistant API")
    api_version: str = Field(default="0.2.0")
    environment: str = Field(default="development")
    log_level: str = Field(default="INFO")
    cors_origins: str = Field(default="http://localhost:5173")

    # --- Database (PostgreSQL + pgvector, required for the real architecture)--
    # postgresql+asyncpg://user:pass@host:port/db
    database_url: str = Field(
        default="postgresql+asyncpg://lenny:lenny@localhost:5432/lenny_growth"
    )
    db_echo: bool = Field(default=False)
    db_pool_size: int = Field(default=5)
    db_max_overflow: int = Field(default=10)
    # Seconds to wait for a connection before health declares the DB unreachable.
    db_connect_timeout_seconds: float = Field(default=3.0)

    # --- Agent service boundary (the existing Node.js Pi service) -------------
    # Base URL of the Node agent-service; /v1/* routes live underneath it.
    agent_service_url: str = Field(default="http://127.0.0.1:8001")
    # Shared secret sent as the X-Internal-Token header. Unset => auth disabled,
    # matching the Node service's own behavior.
    internal_token: str | None = Field(default=None)
    agent_request_timeout_seconds: float = Field(default=10.0)
    # Read timeout for streaming NDJSON tokens off a /v1/turn response.
    agent_turn_timeout_seconds: float = Field(default=120.0)
    # Newest messages sent to the agent as distilled history on each turn.
    chat_history_max_messages: int = Field(default=20)

    # --- Embeddings (local Ollama, independent of any chat provider) ----------
    # Native Ollama root (no /v1 suffix). The embedding endpoint is
    # POST {ollama_base_url}/api/embed.
    ollama_base_url: str = Field(default="http://localhost:11434")
    ollama_embedding_model: str = Field(default="nomic-embed-text")
    embedding_timeout_seconds: float = Field(default=60.0)

    # --- Retrieval + chunking sizing -----------------------------------------
    embedding_dimensions: int = Field(default=768)  # nomic-embed-text output size
    retrieval_top_k: int = Field(default=5)
    # Calibrated on real nomic-embed-text embeddings over the live corpus
    # (2026-10): in-corpus queries score >= 0.631, unrelated queries <= 0.557.
    # 0.60 cleanly separates both measured sets; see test_grounding_calibration.py.
    retrieval_min_score: float = Field(default=0.60)
    chunk_target_tokens: int = Field(default=280)
    chunk_overlap_tokens: int = Field(default=40)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor. Tests can call `get_settings.cache_clear()`."""
    return Settings()
