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

_WEBSITE_NOUNS = re.compile(
    r"\b("
    r"landing\s*page|landingpage|website|web\s*page|webpage|web\s*app|webapp|"
    r"html\s*page|html/css|html\s*artifact|html\s*mockup|html\s*template|"
    r"interactive\s*dashboard|pricing\s*table|portfolio\s*site"
    r")\b",
    re.IGNORECASE,
)

_CREATION_VERB = re.compile(
    r"\b("
    r"create|build|generate|design|make|code|draft|develop|produce|"
    r"render|construct|write|give\s+me|show\s+me"
    r")\b",
    re.IGNORECASE,
)

_REVISION_PATTERNS = re.compile(
    r"\b("
    r"change\s+the\s+theme|revise\s+the|update\s+the\s+(?:page|site|website|hero|landing|section)|"
    r"modify\s+the\s+(?:page|site|website|hero|landing|section)|"
    r"simplify\s+the\s+hero|change\s+the\s+colors?|change\s+the\s+styling|"
    r"add\s+a\s+(?:pricing|feature|hero|footer|header|testimonial)\s+section|"
    r"switch\s+to\s+dark"
    r")\b",
    re.IGNORECASE,
)


def detect_skill(message: str) -> str | None:
    """Return the skill implied by a chat message, or ``None``.

    ``ship30_essay`` triggers on an explicit Ship 30 mention, or on an "essay"
    request phrased with a writing verb ("write an essay", "turn that into a
    Ship 30 essay"). Plain prose that merely mentions "essay" without a writing
    intent is left as a normal Q&A turn.

    ``artifact`` triggers on requests to create or revise complete websites,
    landing pages, interactive dashboards, or explicit artifact mentions.
    """
    text = (message or "").strip().lower()
    if not text:
        return None

    if "ship 30" in text or "ship30" in text:
        return SHIP30_ESSAY

    if "essay" in text and _ESSAY_VERB.search(text):
        return SHIP30_ESSAY

    if "artifact" in text or "standalone" in text or "html view" in text or "markdown view" in text or "artifact viewer" in text:
        return ARTIFACT

    if _WEBSITE_NOUNS.search(text):
        if _CREATION_VERB.search(text) or "for a" in text or "for an" in text or "include" in text or "with a" in text:
            return ARTIFACT

    if _REVISION_PATTERNS.search(text):
        return ARTIFACT

    return None


def effective_skill(explicit: str | None, message: str) -> str | None:
    """Resolve the skill for a turn: an explicit supported value wins, else detect."""
    if explicit:
        cleaned = explicit.strip().lower()
        if is_supported(cleaned):
            return cleaned
    return detect_skill(message)