"""Turn-aware transcript chunking.

Lenny's transcripts are formatted as repeated speaker turns:

    **Elena Verna** (00:00:06):
    We're over 200 million in ARR...

We split on those turn boundaries first, then greedily pack whole turns into a
chunk until a token budget is reached, so a chunk never cuts a speaker
mid-sentence and every chunk keeps a meaningful citation anchor (who said it
and at what timestamp). If the body does not match the expected format we fall
back to splitting on blank lines (paragraphs), and if there are no paragraph
breaks either we emit a single windowed chunk.

Token counts are approximated as ``whitespace words * 1.3`` (a common rule of
thumb for English text). This is a deliberate simplification: it avoids pulling
in a real tokenizer for something that only needs to be roughly right to keep
chunks a sane size for a local model's context window.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

TURN_RE = re.compile(
    r"^\*\*(?P<speaker>[^*]+?)\*\*\s*"
    r"(?:\((?P<timestamp>\d{1,2}:\d{2}(?::\d{2})?)\))?\s*:?[ \t]*"
    r"(?P<inline>.*?)\s*$",
    re.MULTILINE,
)

DEFAULT_TARGET_TOKENS = 280
DEFAULT_OVERLAP_TOKENS = 40

_TOKEN_MULTIPLIER = 1.3


def approx_tokens(text: str) -> int:
    """Rough token estimate. Always >= 1 for non-empty text, else 0."""
    words = len(text.split())
    return max(1, int(words * _TOKEN_MULTIPLIER)) if words else 0


@dataclass
class Turn:
    speaker: str | None
    timestamp: str | None
    text: str


@dataclass
class TranscriptChunk:
    index: int
    content: str
    token_count: int
    start_speaker: str | None = None
    start_timestamp: str | None = None
    end_timestamp: str | None = None
    meta: dict = field(default_factory=dict)


def split_into_turns(body: str) -> list[Turn]:
    """Split a transcript body into speaker turns.

    Falls back to paragraph splitting when the speaker-turn format is absent,
    and to a single turn for a body with no blank-line separation.
    """
    body = (body or "").strip()
    if not body:
        return []

    matches = list(TURN_RE.finditer(body))
    if not matches:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        if len(paragraphs) <= 1:
            return [Turn(speaker=None, timestamp=None, text=body)]
        return [Turn(speaker=None, timestamp=None, text=p) for p in paragraphs]

    turns: list[Turn] = []
    # Text before the first speaker header (e.g. an intro paragraph) is kept.
    preamble = body[: matches[0].start()].strip()
    if preamble:
        turns.append(Turn(speaker=None, timestamp=None, text=preamble))

    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        # Text on the header line itself plus every following line up to the
        # next header. Handles both "**Speaker** (ts):\n<text>" and inline text.
        inline = (match.group("inline") or "").strip()
        following = body[match.end() : end].strip()
        text = "\n".join(part for part in (inline, following) if part).strip()
        if text:
            turns.append(
                Turn(
                    speaker=(match.group("speaker") or "").strip() or None,
                    timestamp=match.group("timestamp"),
                    text=text,
                )
            )
    return turns


def _format_turn(turn: Turn) -> str:
    if turn.speaker:
        stamp = f" ({turn.timestamp})" if turn.timestamp else ""
        return f"**{turn.speaker}**{stamp}: {turn.text}"
    return turn.text


def _tail_overlap(turns: list[Turn], overlap_tokens: int) -> list[Turn]:
    """Return the trailing turns of a chunk whose combined size fits the overlap
    budget, so the next chunk starts with continuity context."""
    if overlap_tokens <= 0:
        return []
    carried: list[Turn] = []
    total = 0
    for turn in reversed(turns):
        size = approx_tokens(_format_turn(turn))
        if total + size > overlap_tokens and carried:
            break
        carried.insert(0, turn)
        total += size
    return carried


def chunk_transcript(
    body: str,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[TranscriptChunk]:
    """Split ``body`` into overlapping chunks of at most ~``target_tokens``.

    A chunk is never split inside a turn. A single turn longer than the target
    is emitted as one (oversized) chunk rather than being cut, preserving its
    citation metadata.
    """
    if target_tokens <= 0:
        raise ValueError("target_tokens must be positive")
    if overlap_tokens < 0:
        raise ValueError("overlap_tokens must be non-negative")

    turns = split_into_turns(body)
    if not turns:
        return []

    chunks: list[TranscriptChunk] = []
    current: list[Turn] = []
    current_tokens = 0

    def flush() -> None:
        nonlocal current, current_tokens
        if not current:
            return
        content = "\n\n".join(_format_turn(t) for t in current)
        chunks.append(
            TranscriptChunk(
                index=len(chunks),
                content=content,
                token_count=approx_tokens(content),
                start_speaker=current[0].speaker,
                start_timestamp=current[0].timestamp,
                end_timestamp=current[-1].timestamp,
            )
        )

    for turn in turns:
        turn_tokens = approx_tokens(_format_turn(turn))

        if current and current_tokens + turn_tokens > target_tokens:
            flush()
            current = _tail_overlap(current, overlap_tokens)
            current_tokens = sum(approx_tokens(_format_turn(t)) for t in current)

        current.append(turn)
        current_tokens += turn_tokens

    flush()
    return chunks
