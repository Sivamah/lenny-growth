"""Skill detection unit tests (no DB, no services)."""
from __future__ import annotations

from app.agent.skills import ARTIFACT, SHIP30_ESSAY, detect_skill, effective_skill


def test_ship_30_mention_always_triggers():
    assert detect_skill("Turn this into a Ship 30 essay") == SHIP30_ESSAY
    assert detect_skill("I want a Ship 30 for 30 essay about retention") == SHIP30_ESSAY
    assert detect_skill("write a ship30 essay") == SHIP30_ESSAY
    assert detect_skill("Watch the SHIP 30 examples first") == SHIP30_ESSAY


def test_essay_with_writing_verb_triggers():
    assert detect_skill("Write an essay about pricing") == SHIP30_ESSAY
    assert detect_skill("Turn that into an essay") == SHIP30_ESSAY
    assert detect_skill("Can you draft an essay on activation?") == SHIP30_ESSAY


def test_artifact_mention_triggers():
    assert detect_skill("Generate a standalone artifact") == ARTIFACT
    assert detect_skill("Create an html view of the findings") == ARTIFACT
    assert detect_skill("Please build an artifact for this framework") == ARTIFACT


def test_website_creation_triggers_artifact():
    assert detect_skill("Create a polished, responsive landing page for an AI-powered productivity startup") == ARTIFACT
    assert detect_skill("Build a landing page for my product") == ARTIFACT
    assert detect_skill("Design a website for an agency") == ARTIFACT
    assert detect_skill("Generate an HTML page with navbar and hero") == ARTIFACT
    assert detect_skill("Make an interactive dashboard for cohort retention") == ARTIFACT


def test_website_revision_triggers_artifact():
    assert detect_skill("Change the theme to dark navy and violet, and simplify the hero section") == ARTIFACT
    assert detect_skill("Update the page to add a pricing section") == ARTIFACT
    assert detect_skill("Modify the website layout for mobile") == ARTIFACT


def test_plain_mentions_do_not_trigger():
    assert detect_skill("I disagree with that essay you shared") is None
    assert detect_skill("essay") is None
    assert detect_skill("") is None
    assert detect_skill("Why does this essay exit confuse people") is None
    assert detect_skill("What is a landing page?") is None
    assert detect_skill("How do startups design websites?") is None


def test_effective_skill_explicit_wins_then_detection():
    assert effective_skill("ship30_essay", "tell me about pricing") == SHIP30_ESSAY
    assert effective_skill("artifact", "tell me about pricing") == ARTIFACT
    assert effective_skill(None, "Turn that into a Ship 30 essay") == SHIP30_ESSAY
    assert effective_skill(None, "Generate an artifact") == ARTIFACT
    assert effective_skill(None, "Create a landing page for my startup") == ARTIFACT
    # Unsupported explicit value falls back to detection…
    assert effective_skill("unknown_skill", "write an essay") == SHIP30_ESSAY
    assert effective_skill("unknown_skill", "create an artifact") == ARTIFACT
    # …and detection is a no-op for ordinary questions.
    assert effective_skill(None, "plain question") is None
    assert effective_skill("unknown_skill", "plain question") is None