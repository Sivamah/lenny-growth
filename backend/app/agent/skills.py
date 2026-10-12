"""Skill routing: map a user message / explicit request field to a skill name.

The only implemented skill is `ship30_essay` (Ship 30 for 30 essay). Detection
is deliberately conservative: an explicit ``skill`` field on the chat request
always wins; otherwise keyword heuristics triple-check the intent before the
essay pipeline is engaged.
"""
from __future__ import annotations

import re

SHIP30_ESSAY: str = "ship30_essay"
ARTIFACT: str = "artifact"

_SUPPORTED = frozenset({SHIP30_ESSAY, ARTIFACT})
"""Skills the backend understands and will forward to the agent-service."""

_ESSAY_VERB = re.compile(r"\b(turn|rewrite|write|draft|create|make|produce)\b", re.IGNORECASE)


def is_supported(skill: str | None) -> bool:
    return skill in _SUPPORTED


def detect_skill(message: str) -> str | None:
    """Return the skill implied by a chat message, or ``None``.

    ``ship30_essay`` triggers on an explicit Ship 30 mention, or on an "essay"
    request phrased with a writing verb ("write an essay", "turn that into a
    Ship 30 essay"). Plain prose that merely mentions "essay" without a writing
    intent is left as a normal Q&A turn.
    """
    text = (message or "").strip().lower()
    if not text:
        return None

    if "ship 30" in text or "ship30" in text:
        return SHIP30_ESSAY

    if "essay" in text and _ESSAY_VERB.search(text):
        return SHIP30_ESSAY

    if "artifact" in text or "standalone" in text or "html view" in text or "markdown view" in text:
        return ARTIFACT

    return None


def effective_skill(explicit: str | None, message: str) -> str | None:
    """Resolve the skill for a turn: an explicit supported value wins, else detect."""
    if explicit:
        cleaned = explicit.strip().lower()
        if is_supported(cleaned):
            return cleaned
    return detect_skill(message)