"""Ingestion tests: frontmatter parsing, idempotent delete, outcomes.

Uses a fake session and a fake embedder so no database or Ollama is required.
The real database write path is exercised by the live ingestion run, not here.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from app.db.models import Chunk, Transcript
from app.services.embeddings import EmbeddingError, deterministic_test_embedding
from app.services.ingestion import _delete_existing, ingest_directory, parse_transcript_file

FRONTMATTER = """---
title: "Elena Verna 4.0"
date: "2025-12-18"
guest: "Elena Verna"
post_url: "https://www.lennyspodcast.com/episodes/elena-verna-4"
word_count: 3
---

**A** (00:00:01): hello there friend and welcome
**B** (00:00:05): thanks so much for having me today
"""


class _ScalarResult:
    def __init__(self, obj):
        self._obj = obj

    def scalar_one_or_none(self):
        return self._obj


class FakeDB:
    def __init__(self, existing=None):
        self.existing = existing
        self.calls = 0
        self.deletes = 0
        self.added: list[object] = []
        self.flushes = 0
        self.commits = 0
        self.rollbacks = 0

    async def execute(self, stmt):
        self.calls += 1
        if self.calls == 1 and self.existing is not None:
            return _ScalarResult(self.existing)
        if str(stmt).strip().lower().startswith("delete"):
            self.deletes += 1
        return _ScalarResult(None)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        self.flushes += 1

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1


class FakeEmbedder:
    def __init__(self, dimensions: int = 32):
        self.dimensions = dimensions
        self.calls = 0

    async def embed(self, texts):
        self.calls += 1
        return [deterministic_test_embedding(t, self.dimensions) for t in texts]


class FailingEmbedder:
    async def embed(self, texts):
        raise EmbeddingError("ollama down")


def _write(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path


def test_parse_transcript_file_reads_frontmatter(tmp_path):
    path = _write(tmp_path, "elena-verna-40.md", FRONTMATTER)
    parsed = parse_transcript_file(path)
    assert parsed.slug == "elena-verna-40"
    assert parsed.title == "Elena Verna 4.0"
    assert parsed.guest == "Elena Verna"
    assert parsed.published_at == "2025-12-18"
    assert parsed.source_url == "https://www.lennyspodcast.com/episodes/elena-verna-4"
    assert parsed.word_count == 3
    assert "hello there friend" in parsed.body


def test_parse_transcript_file_without_frontmatter(tmp_path):
    path = _write(tmp_path, "bare.md", "just some words here\n")
    parsed = parse_transcript_file(path)
    assert parsed.slug == "bare"
    assert parsed.title == "bare"
    assert parsed.guest is None
    assert parsed.source_url is None
    assert parsed.word_count == 4


async def test_delete_existing_removes_chunks_and_transcript():
    existing = SimpleNamespace(id="t1")
    db = FakeDB(existing=existing)
    # first execute returns the existing transcript, then two deletes
    await _delete_existing(db, "slug")
    assert db.deletes == 2
    assert db.flushes == 1

    db2 = FakeDB(existing=None)
    await _delete_existing(db2, "slug")
    assert db2.deletes == 0


async def test_ingest_directory_no_files(tmp_path):
    result = await ingest_directory(FakeDB(), tmp_path, FakeEmbedder(), 280, 40)
    assert result.outcomes == []
    assert result.transcripts == 0


async def test_ingest_directory_empty_transcript_is_skipped(tmp_path):
    _write(tmp_path, "empty.md", "---\ntitle: Empty\n---\n\n   \n")
    embedder = FakeEmbedder()
    result = await ingest_directory(FakeDB(), tmp_path, embedder, 280, 40)
    assert result.transcripts == 0
    assert result.skipped == 1
    assert embedder.calls == 0


async def test_ingest_directory_success_writes_transcript_and_chunks(tmp_path):
    _write(tmp_path, "elena-verna-40.md", FRONTMATTER)
    db = FakeDB()
    result = await ingest_directory(db, tmp_path, FakeEmbedder(), target_tokens=10, overlap_tokens=0)
    assert result.transcripts == 1
    assert result.chunks >= 1
    assert db.commits == 1
    transcripts = [o for o in db.added if isinstance(o, Transcript)]
    chunks = [o for o in db.added if isinstance(o, Chunk)]
    assert len(transcripts) == 1
    assert len(chunks) == result.chunks
    assert all(c.embedding for c in chunks)


async def test_ingest_directory_embedding_failure_is_isolated(tmp_path):
    _write(tmp_path, "a.md", FRONTMATTER)
    _write(tmp_path, "b.md", FRONTMATTER.replace("4.0", "5.0"))
    db = FakeDB()
    result = await ingest_directory(db, tmp_path, FailingEmbedder(), 280, 40)
    assert result.transcripts == 0
    assert len(result.failures) == 2
    assert all(o.status == "failed" for o in result.failures)
    assert db.rollbacks == 2
    assert db.commits == 0
