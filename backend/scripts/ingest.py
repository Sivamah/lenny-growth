"""CLI: ingest permitted transcript markdown files into the knowledge base.

Usage (from backend/):
    uv run python scripts/ingest.py                 # ingest ../data/transcripts
    uv run python scripts/ingest.py --dir some/dir  # ingest a different directory
    uv run python scripts/ingest.py --dry-run       # chunk + count, no DB/embeddings

The default directory is the project's ``data/transcripts`` (git-ignored). See
``data/README.md`` for the source and its license: personal, non-commercial use
only — raw transcripts must not be redistributed or committed.

This command requires a reachable PostgreSQL (with pgvector) and a running
Ollama embedding model. If the embedding model is unavailable it aborts rather
than silently writing synthetic vectors.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.db.base import SessionLocal  # noqa: E402
from app.db.session import check_database  # noqa: E402
from app.logging_config import configure_logging  # noqa: E402
from app.services.chunker import chunk_transcript  # noqa: E402
from app.services.embeddings import EmbeddingService  # noqa: E402
from app.services.ingestion import ingest_directory, parse_transcript_file  # noqa: E402

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "transcripts"


def _print_outcome(position: int, total: int, filename: str, status: str, chunks: int, error: str | None) -> None:
    suffix = f" - {error}" if error else ""
    print(f"  [{position}/{total}] {filename}: {status} ({chunks} chunks){suffix}")


def dry_run(directory: Path, target_tokens: int, overlap_tokens: int) -> int:
    files = sorted(directory.glob("*.md"))
    print(f"DRY RUN: {len(files)} file(s) in {directory}")
    if not files:
        print("No .md files found. Run scripts/fetch_transcripts.sh first.")
        return 1
    total_chunks = 0
    for position, path in enumerate(files, start=1):
        parsed = parse_transcript_file(path)
        chunks = chunk_transcript(parsed.body, target_tokens=target_tokens, overlap_tokens=overlap_tokens)
        total_chunks += len(chunks)
        _print_outcome(position, len(files), path.name, "parsed", len(chunks), None)
    print(f"DRY RUN complete: {len(files)} transcript(s), {total_chunks} chunk(s). No data written.")
    return 0


async def _run(directory: Path, target_tokens: int, overlap_tokens: int) -> int:
    settings = get_settings()
    configure_logging(settings.log_level)

    db_ok, db_error = await check_database()
    if not db_ok:
        print(
            "ERROR: PostgreSQL is not reachable; cannot ingest.\n"
            f"  DATABASE_URL={settings.database_url}\n"
            f"  detail={db_error}\n"
            "Start PostgreSQL + pgvector and run `uv run alembic upgrade head` first."
        )
        return 3

    embedder = EmbeddingService(settings)
    if not await embedder.is_available():
        print(
            "ERROR: Ollama embedding model is not reachable; refusing to ingest with "
            "synthetic vectors.\n"
            f"  OLLAMA_BASE_URL={settings.ollama_base_url}  model={settings.ollama_embedding_model}\n"
            "Start `ollama serve` and `ollama pull nomic-embed-text`, then retry."
        )
        return 4

    if not directory.exists():
        print(f"ERROR: directory not found: {directory}")
        return 1

    files = sorted(directory.glob("*.md"))
    total = len(files)
    print(f"Ingesting {total} file(s) from {directory} (model={settings.ollama_embedding_model})")

    counter = {"n": 0}

    def on_progress(outcome) -> None:
        counter["n"] += 1
        _print_outcome(
            counter["n"], total, outcome.filename, outcome.status, outcome.chunks, outcome.error
        )

    async with SessionLocal() as db:
        result = await ingest_directory(
            db,
            directory,
            embedder,
            target_tokens=target_tokens,
            overlap_tokens=overlap_tokens,
            on_progress=on_progress,
        )

    print(
        f"Done. transcripts={result.transcripts} chunks={result.chunks} "
        f"skipped_empty={result.skipped} failed={len(result.failures)}"
    )
    return 1 if result.failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest transcript markdown into the knowledge base.")
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    parser.add_argument("--target-tokens", type=int, default=None)
    parser.add_argument("--overlap-tokens", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true", help="Chunk and count only; no DB writes.")
    args = parser.parse_args()

    settings = get_settings()
    target = args.target_tokens if args.target_tokens is not None else settings.chunk_target_tokens
    overlap = args.overlap_tokens if args.overlap_tokens is not None else settings.chunk_overlap_tokens

    if args.dry_run:
        return dry_run(args.dir, target, overlap)
    return asyncio.run(_run(args.dir, target, overlap))


if __name__ == "__main__":
    raise SystemExit(main())
