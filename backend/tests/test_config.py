"""Configuration tests (no database required)."""
from __future__ import annotations

from app.config import Settings, get_settings


def test_defaults_are_postgres_and_sane():
    settings = Settings(_env_file=None)  # ignore any local .env for determinism
    assert settings.database_url.startswith("postgresql+asyncpg://")
    assert settings.embedding_dimensions == 768
    assert settings.retrieval_top_k == 5
    assert settings.retrieval_min_score == 0.60
    assert settings.internal_token is None
    assert settings.agent_service_url == "http://127.0.0.1:8001"
    assert settings.agent_turn_timeout_seconds == 120.0
    assert settings.chat_history_max_messages == 20


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@h:5432/d")
    monkeypatch.setenv("INTERNAL_TOKEN", "shared-secret")
    monkeypatch.setenv("CORS_ORIGINS", "http://a, http://b ,")
    monkeypatch.setenv("EMBEDDING_DIMENSIONS", "1024")

    settings = Settings(_env_file=None)
    assert settings.database_url == "postgresql+asyncpg://u:p@h:5432/d"
    assert settings.internal_token == "shared-secret"
    assert settings.embedding_dimensions == 1024
    assert settings.cors_origin_list == ["http://a", "http://b"]


def test_get_settings_is_cached():
    get_settings.cache_clear()
    assert get_settings() is get_settings()
    get_settings.cache_clear()
