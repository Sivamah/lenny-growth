# Lenny Growth Assistant V2 (Lenny Growth Studio)

A production-grade, full-stack AI research workspace and growth assistant built on the corpus of Lenny's Podcast transcripts. Features a modern spatial canvas studio interface, streaming grounded responses, interactive standalone artifact creation (HTML & Markdown), Ship 30 for 30 essay generation, and persistent multi-session conversation history.

---

## Architecture Overview

```
                      +-----------------------------------+
                      |       React + Vite Frontend       |
                      |   (Lenny Growth Studio Canvas)    |
                      +-----------------+-----------------+
                                        | SSE / REST
                                        v
                      +-----------------+-----------------+
                      |         FastAPI Backend           |
                      | (Session Persistence + Retrieval) |
                      +--------+----------------+---------+
                               |                |
             Internal NDJSON   |                | SQLAlchemy (async)
                               v                v
      +------------------------+---+      +-----+---------------------+
      |     Node Agent Service     |      |  PostgreSQL 16 + pgvector  |
      | (Pi Coding Agent SDK +     |      | (Sessions, Messages,       |
      |  Ollama llama3.2:3b)       |      |  Artifacts, Embeddings)   |
      +----------------------------+      +---------------------------+
```

1. **Frontend (`/frontend`)**:
   - Modern editorial "Canvas Studio" UI with dark, light, and system themes.
   - Streaming SSE chat parser with live Markdown rendering.
   - Dedicated **Artifact Mode** composer with non-destructive activation, cancel on Esc, and custom prompt dispatch.
   - Secure **ArtifactViewer** with strict `sandbox=""` iframe, strict Content-Security-Policy (CSP), and DOMPurify sanitization.

2. **Backend (`/backend`)**:
   - FastAPI async service managing database persistence and transcript vector search.
   - SQLAlchemy 2.0 async engine with Alembic migrations.
   - Embeddings and hybrid retrieval with calibrated grounding confidence scores.
   - Secure internal communication with `X-Internal-Token` authentication.

3. **Agent Service (`/agent-service`)**:
   - Node.js / TypeScript service wrapping the `@earendil-works/pi-coding-agent` SDK.
   - Communicates with Ollama (`llama3.2:3b` default) or optional cloud providers (Anthropic Claude).
   - Dedicated skill pipelines:
     - `ship30_essay`: buffered essay drafting with automated structural quality review and single-retry correction.
     - `artifact`: structured artifact generation with tool-call leakage prevention and heading/title extraction.
   - Real-time `search_transcripts` tool execution with citation generation.

4. **Database (`docker-compose.yml`)**:
   - PostgreSQL 16 with `pgvector/pgvector:pg16` for vector similarity and metadata queries.

---

## Quickstart & Local Startup

### Prerequisites
- Node.js >= 22.19.0
- Python 3.12 (with `uv` installed)
- Docker Desktop (for PostgreSQL + pgvector)
- Ollama with model `llama3.2:3b` pulled (`ollama pull llama3.2:3b`)

### 1. Database
```powershell
# From project root
docker compose up -d db
```
Verifies running on `localhost:5432`.

### 2. FastAPI Backend
```powershell
cd backend
uv venv --python 3.12
uv pip install -r requirements-dev.txt
uv run alembic upgrade head
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```
API Documentation available at: http://127.0.0.1:8000/docs  
Health Check: http://127.0.0.1:8000/health

### 3. Agent Service
```powershell
cd agent-service
npm install
npm start
```
Listens on `http://127.0.0.1:8001`.

### 4. Frontend
```powershell
cd frontend
npm install
npm run dev
```
Accessible at: http://localhost:5173/

---

## Running Test Suites

All regression test suites pass cleanly across all subsystems:

### Frontend Tests
```powershell
cd frontend
npm test             # 28 passing Vitest tests
npm run typecheck    # 0 TypeScript diagnostics
npm run build        # Production bundle generated successfully
```

### Agent Service Tests
```powershell
cd agent-service
npm test             # Full suite including live Ollama turn test
npm run test:unit    # Unit test suite (37 passing tests across 5 suites)
npm run typecheck    # 0 TypeScript diagnostics
```

### Backend Tests
```powershell
cd backend
uv run python -m pytest -v    # 98 test items (96 passed, 2 skipped, 0 failed)
```

---

## Security & Sanitization
- **Strict Iframe Sandboxing**: Artifacts render in an iframe with `sandbox=""` (disables all script execution, top-level navigation, same-origin access).
- **Content-Security-Policy (CSP)**: `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data: https:;`
- **DOMPurify Sanitization**: HTML is sanitized removing active script tags, inline event handlers, and embedded objects before iframe embedding.
- **Environment Secrets Exclusion**: `.env` and `**/.env` are strictly git-ignored; `.env.example` templates provide non-sensitive defaults.
