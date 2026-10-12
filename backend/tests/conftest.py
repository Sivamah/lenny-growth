"""Shared test fixtures.

These tests are intentionally runnable without a live PostgreSQL instance:
configuration and schema tests are pure, and API tests monkeypatch the database
dependency rather than connecting. Anything that would require a real database is
marked and skipped here (see tests/test_database_optional.py).
"""
from __future__ import annotations

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def clear_settings_cache():
    """Prevent env-dependent Settings from leaking between tests."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
