# Lenny Growth Assistant — Backend (FastAPI)

FastAPI service that owns **data persistence** (PostgreSQL + pgvector via
SQLAlchemy 2.0 async) and **transcript retrieval** (ingest → embed → rank). The
agent runtime itself lives in the sibling Node.js `agent-service` (Pi SDK +
Ollama); this backend talks to it over the documented internal HTTP interface
(`/v1/health`, `/v1/turn`, `/v1/abort`, `/v1/sessions/{id}`) using a shared
`X-Internal-Token` header, and the agent calls back into
`POST /internal/retrieve` for transcript evidence.

## Requirements

- Python 3.12 (verified on 3.12.13)
- [`uv`](https://docs.astral.sh/uv/) for environment management
- PostgreSQL 16 with the `pgvector` extension for the live database path
  (e.g. the `pgvector/pgvector:pg16` image). Not required to run unit tests.

## Setup

```powershell
# from backend/
uv venv --python 3.12
uv pip install -r requirements-dev.txt        # includes requirements.txt + pytest
Copy-Item .env.example .env                    # optional; defaults are safe
```

## Run

```powershell
# from backend/
uv run uvicorn app.main:app --reload
# or
uv run python -m app.main
```

- API docs: http://127.0.0.1:8000/docs
- Health: http://127.0.0.1:8000/health (returns `200` and `"status": "degraded"`
  when PostgreSQL / the agent-service are unreachable — it never 500s for that).

## Tests

```powershell
# from backend/
uv run pytest
```

Tests are runnable **without a live database**: config/schema tests are pure, and
API tests monkeypatch the DB dependency. The one live-schema test in
`tests/test_database_optional.py` skips itself when PostgreSQL is unreachable.

## Database & migrations (Alembic)

The schema is created by Alembic, not `create_all`. Placeholder `sqlalchemy.url`
in `alembic.ini` is overridden at runtime from `DATABASE_URL` / app settings.

```powershell
# from backend/
uv run alembic upgrade head            # requires a running PostgreSQL 16 + pgvector

# Generate the DDL without a database (offline mode) — useful for review/CI:
uv run alembic upgrade head --sql
```

Migrations:

- `0001_initial_schema` — runs `CREATE EXTENSION IF NOT EXISTS vector`; creates
  `sessions`, `messages`, `transcripts`, `chunks`, `artifacts` with native
  PostgreSQL `uuid` primary keys and timezone-aware timestamps; gives
  `chunks.embedding` a `vector(768)` column and an HNSW cosine index.
- `0002_chunk_metadata` — adds `start_speaker`, `start_timestamp`, and `meta` to
  `chunks` so retrieval can return citation anchors.

> The embedding dimension is fixed at 768 in the migration (matching the default
> `EMBEDDING_DIMENSIONS` and `nomic-embed-text`). Changing the dimension requires
> a new migration.

## Ingesting transcripts

Transcripts are ingested with a real local Ollama embedding model
(`nomic-embed-text`, 768-d). The raw `.md` corpus lives in the (git-ignored)
`../data/transcripts`; see `../data/README.md` for the source license
(personal, non-commercial; raw files must not be redistributed).

```powershell
# from backend/
uv run python scripts/ingest.py             # embed + upsert into PostgreSQL
uv run python scripts/ingest.py --dry-run   # chunk + count only (no DB/Ollama)
```

Ingestion is **idempotent** (keyed by slug; re-running replaces a transcript),
commits **per transcript**, and reports per-file progress and failures. It
**aborts** if PostgreSQL or Ollama is unavailable rather than writing synthetic
vectors.

## Internal retrieval endpoint

`POST /internal/retrieve` — consumed by the Node agent-service's
`search_transcripts` tool. Requires `X-Internal-Token` when `INTERNAL_TOKEN` is
set. Body `{ "query": "...", "top_k": 5 }`. It embeds the query with the same
Ollama model, ranks chunks with pgvector (`<=>` cosine), and returns:

```json
{ "query": "...", "grounded": true, "max_score": 0.82, "source": "fastapi",
  "results": [ { "chunk_id": "...", "transcript_slug": "jason-cohen",
    "episode_title": "...", "guest": "Jason Cohen", "timestamp": "00:12:30",
    "source_url": "https://...", "chunk_index": 0, "content": "...", "score": 0.82 } ] }
```

`grounded` is `max_score >= RETRIEVAL_MIN_SCORE`. Empty results return `200`
with `grounded: false`. Embedding or database failures return `503` with a safe,
generic message (no stack traces or credentials).

## Configuration

All settings are environment variables read in `app/config.py`; see
`.env.example`. Highlights:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql+asyncpg://lenny:lenny@localhost:5432/lenny_growth` | Async SQLAlchemy URL |
| `AGENT_SERVICE_URL` | `http://127.0.0.1:8001` | Node agent-service base URL |
| `INTERNAL_TOKEN` | _(unset)_ | Shared secret → `X-Internal-Token` header |
| `AGENT_TURN_TIMEOUT_SECONDS` | `120` | Streaming NDJSON read timeout per turn |
| `CHAT_HISTORY_MAX_MESSAGES` | `20` | Newest messages replayed as agent history |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Native Ollama root (`/api/embed`) |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `768` | pgvector column size |
| `CHUNK_TARGET_TOKENS` | `280` | Target tokens per chunk |
| `CHUNK_OVERLAP_TOKENS` | `40` | Overlap tokens between chunks |
| `RETRIEVAL_TOP_K` | `5` | Default retrieval result count |
| `RETRIEVAL_MIN_SCORE` | `0.60` | Grounding threshold (calibrated against live corpus) |
| `LOG_LEVEL` | `INFO` | Structured JSON logging level |

## Layout

```
backend/
  app/
    main.py                 FastAPI app factory + uvicorn entry point
    config.py               Pydantic Settings
    logging_config.py       structured JSON logging
    api/
      deps.py               get_db, get_agent_client, get_embedder
      security.py           require_internal_token (X-Internal-Token)
      routes/health.py      GET /health
      routes/sessions.py    POST/GET /sessions
      routes/retrieval.py   POST /internal/retrieve
    db/
      base.py               async engine, session factory, Base
      session.py            get_db, session_scope, check_database
      types.py              dialect-aware pgvector column type
      models.py             sessions, messages, transcripts, chunks, artifacts
    schemas/                health / session / retrieval Pydantic schemas
    services/
      agent_client.py       Node agent-service boundary client
      chunker.py            turn-aware transcript chunking (pure)
      embeddings.py         Ollama /api/embed client + strict validation
      ingestion.py          idempotent markdown -> chunks -> vectors -> DB
      retriever.py          pgvector search + pure ranking core
  migrations/               Alembic env + versions
  scripts/ingest.py         ingestion CLI (--dry-run supported)
  tests/
```

## Explicitly not in this phase

- Chat/streaming proxy to the agent-service (the Node service owns the agent loop).
- Artifacts and the Ship 30 skill.
- React frontend.
- Dockerfile / docker-compose (Docker is unavailable in the build environment).
