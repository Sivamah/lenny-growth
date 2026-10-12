"""Transcript ingestion: markdown files -> chunks -> real embeddings -> Postgres.

Idempotency: a transcript is keyed by its slug. Re-running ingestion deletes the
existing row (chunks cascade) and re-inserts, so the pipeline is safe to re-run
and there is no separate "initial load" vs "refresh" path to keep in sync.

Commit granularity: one commit per transcript. Embedding is the slow step (one
HTTP round-trip per batch to a CPU-bound local Ollama), so committing per file
bounds what a crash/timeout/Ctrl-C can lose to "redo the current file", making
ingestion resumable in practice and not just idempotent in theory.

Failures are isolated per file: a malformed or un-embeddable transcript is
recorded as a failure and the run continues with the rest.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Chunk, Transcript
from app.services.chunker import chunk_transcript
from app.services.embeddings import EmbeddingError, EmbeddingService

logger = logging.getLogger(__name__)


@dataclass
class ParsedTranscript:
    slug: str
    title: str
    guest: str | None
    published_at: str | None
    source_url: str | None
    word_count: int | None
    body: str
    meta: dict = field(default_factory=dict)


@dataclass
class FileOutcome:
    filename: str
    slug: str | None
    chunks: int
    status: str  # "ingested" | "skipped_empty" | "failed"
    error: str | None = None


@dataclass
class IngestResult:
    outcomes: list[FileOutcome] = field(default_factory=list)

    @property
    def transcripts(self) -> int:
        return sum(1 for o in self.outcomes if o.status == "ingested")

    @property
    def chunks(self) -> int:
        return sum(o.chunks for o in self.outcomes)

    @property
    def skipped(self) -> int:
        return sum(1 for o in self.outcomes if o.status == "skipped_empty")

    @property
    def failures(self) -> list[FileOutcome]:
        return [o for o in self.outcomes if o.status == "failed"]


def _parse_frontmatter(raw: str) -> tuple[dict, str]:
    if not raw.startswith("---"):
        return {}, raw
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return {}, raw
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        meta = {}
    return (meta if isinstance(meta, dict) else {}), parts[2]


def parse_transcript_file(path: Path) -> ParsedTranscript:
    """Parse a transcript markdown file. Missing metadata is tolerated."""
    raw = path.read_text(encoding="utf-8")
    meta, body = _parse_frontmatter(raw)
    body = body.strip()

    published_at = meta.get("date") or meta.get("published_at")
    source_url = meta.get("post_url") or meta.get("source_url") or meta.get("url")
    word_count = meta.get("word_count")
    try:
        word_count = int(word_count) if word_count is not None else None
    except (TypeError, ValueError):
        word_count = None

    return ParsedTranscript(
        slug=str(meta.get("slug") or path.stem),
        title=str(meta.get("title") or path.stem),
        guest=(str(meta["guest"]) if meta.get("guest") else None),
        published_at=(str(published_at) if published_at else None),
        source_url=(str(source_url) if source_url else None),
        word_count=word_count if word_count is not None else len(body.split()),
        body=body,
        meta={k: v for k, v in meta.items() if k not in {"title", "guest", "date", "word_count"}},
    )


ProgressCallback = Callable[[FileOutcome], None]


async def _delete_existing(db: AsyncSession, slug: str) -> None:
    existing = (
        await db.execute(select(Transcript).where(Transcript.slug == slug))
    ).scalar_one_or_none()
    if existing is not None:
        # Explicit child delete avoids relying on ORM cascade ordering and works
        # even if the session is configured without eager relationship loading.
        await db.execute(delete(Chunk).where(Chunk.transcript_id == existing.id))
        await db.execute(delete(Transcript).where(Transcript.id == existing.id))
        await db.flush()


async def _ingest_one(
    db: AsyncSession,
    path: Path,
    embedder: EmbeddingService,
    target_tokens: int,
    overlap_tokens: int,
) -> FileOutcome:
    parsed = parse_transcript_file(path)

    chunks = chunk_transcript(
        parsed.body, target_tokens=target_tokens, overlap_tokens=overlap_tokens
    )
    if not chunks:
        logger.warning("ingestion_empty_transcript", extra={"slug": parsed.slug})
        return FileOutcome(path.name, parsed.slug, 0, "skipped_empty")

    logger.info("embedding_started", extra={"slug": parsed.slug, "chunks": len(chunks)})
    vectors = await embedder.embed([c.content for c in chunks])

    await _delete_existing(db, parsed.slug)

    transcript = Transcript(
        slug=parsed.slug,
        title=parsed.title,
        guest=parsed.guest,
        published_at=parsed.published_at,
        source_url=parsed.source_url,
        word_count=parsed.word_count,
        meta=parsed.meta,
    )
    db.add(transcript)
    await db.flush()

    for chunk, vector in zip(chunks, vectors, strict=True):
        db.add(
            Chunk(
                transcript_id=transcript.id,
                chunk_index=chunk.index,
                content=chunk.content,
                token_count=chunk.token_count,
                start_speaker=chunk.start_speaker,
                start_timestamp=chunk.start_timestamp,
                meta={"end_timestamp": chunk.end_timestamp} if chunk.end_timestamp else {},
                embedding=vector,
            )
        )

    await db.commit()
    logger.info("ingested_transcript", extra={"slug": parsed.slug, "chunks": len(chunks)})
    return FileOutcome(path.name, parsed.slug, len(chunks), "ingested")


async def ingest_directory(
    db: AsyncSession,
    directory: Path,
    embedder: EmbeddingService,
    target_tokens: int,
    overlap_tokens: int,
    on_progress: ProgressCallback | None = None,
) -> IngestResult:
    result = IngestResult()
    files = sorted(directory.glob("*.md"))
    if not files:
        logger.warning("ingestion_no_files", extra={"directory": str(directory)})
        return result

    total = len(files)
    for position, path in enumerate(files, start=1):
        try:
            outcome = await _ingest_one(
                db, path, embedder, target_tokens, overlap_tokens
            )
        except EmbeddingError as exc:
            await db.rollback()
            logger.error("ingestion_embedding_failed", extra={"file": path.name, "error": str(exc)})
            outcome = FileOutcome(path.name, None, 0, "failed", str(exc))
        except Exception as exc:  # noqa: BLE001 - one bad file must not kill the run
            await db.rollback()
            logger.error("ingestion_file_failed", extra={"file": path.name, "error": str(exc)})
            outcome = FileOutcome(path.name, None, 0, "failed", str(exc))

        result.outcomes.append(outcome)
        logger.info(
            "ingestion_progress",
            extra={"position": position, "total": total, "file": path.name, "status": outcome.status},
        )
        if on_progress is not None:
            on_progress(outcome)

    return result
