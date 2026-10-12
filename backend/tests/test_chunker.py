"""Chunker tests: boundaries, overlap, metadata preservation, edge cases."""
from __future__ import annotations

import pytest

from app.services.chunker import (
    TranscriptChunk,
    approx_tokens,
    chunk_transcript,
    split_into_turns,
)

TURNS_BODY = (
    "**A** (00:00:01): one two three four five six seven eight nine ten\n"
    "**B** (00:00:05): eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty\n"
    "**A** (00:00:10): twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven twentyeight twentynine thirty\n"
)


def test_empty_and_whitespace_return_no_chunks():
    assert chunk_transcript("") == []
    assert chunk_transcript("   \n\n  \t ") == []


def test_single_small_transcript_is_one_chunk_with_metadata():
    chunks = chunk_transcript(TURNS_BODY, target_tokens=10_000, overlap_tokens=40)
    assert len(chunks) == 1
    chunk = chunks[0]
    assert isinstance(chunk, TranscriptChunk)
    assert chunk.index == 0
    assert chunk.start_speaker == "A"
    assert chunk.start_timestamp == "00:00:01"
    assert chunk.end_timestamp == "00:00:10"
    assert chunk.token_count > 0
    assert "**B** (00:00:05):" in chunk.content  # speaker + timestamp preserved in body


def test_boundaries_split_into_multiple_chunks():
    chunks = chunk_transcript(TURNS_BODY, target_tokens=20, overlap_tokens=0)
    assert len(chunks) == 3
    assert [c.index for c in chunks] == [0, 1, 2]
    assert all(c.content.strip() for c in chunks)


def test_overlap_carries_trailing_turn_into_next_chunk():
    chunks = chunk_transcript(TURNS_BODY, target_tokens=20, overlap_tokens=15)
    assert len(chunks) == 3
    first_turn_of_second = chunks[1].content.split("\n\n")[0]
    assert first_turn_of_second.startswith("**A** (00:00:01):")


def test_no_overlap_when_budget_zero():
    chunks = chunk_transcript(TURNS_BODY, target_tokens=20, overlap_tokens=0)
    assert chunks[1].content.split("\n\n")[0].startswith("**B** (00:00:05):")


def test_single_oversized_turn_is_not_cut():
    body = "**A** (00:00:01): " + " ".join(f"word{i}" for i in range(400))
    chunks = chunk_transcript(body, target_tokens=20, overlap_tokens=5)
    assert len(chunks) == 1
    assert chunks[0].start_speaker == "A"
    assert chunks[0].token_count > 20


def test_missing_metadata_uses_paragraph_fallback():
    body = "First paragraph with several words here.\n\nSecond paragraph also with several words.\n\nThird one too."
    turns = split_into_turns(body)
    assert len(turns) == 3
    assert all(t.speaker is None and t.timestamp is None for t in turns)

    chunks = chunk_transcript(body, target_tokens=5, overlap_tokens=0)
    assert len(chunks) >= 2
    assert chunks[0].start_speaker is None
    assert chunks[0].start_timestamp is None


def test_preamble_before_first_speaker_is_kept():
    body = "Intro line without a speaker.\n\n**A** (00:00:01): hello there"
    chunks = chunk_transcript(body, target_tokens=10_000, overlap_tokens=0)
    assert len(chunks) == 1
    assert "Intro line" in chunks[0].content
    assert chunks[0].start_speaker is None  # chunk starts at the preamble
    assert "**A** (00:00:01):" in chunks[0].content


def test_invalid_arguments_raise():
    with pytest.raises(ValueError):
        chunk_transcript("hello", target_tokens=0)
    with pytest.raises(ValueError):
        chunk_transcript("hello", target_tokens=10, overlap_tokens=-1)


def test_approx_tokens_is_monotonic_and_zero_for_empty():
    assert approx_tokens("") == 0
    assert approx_tokens("one two three") >= 3
    assert approx_tokens("one two three four five") > approx_tokens("one two three")
