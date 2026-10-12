# Lenny Growth Assistant V2 (Lenny Growth Studio)

A production-grade, full-stack AI research workspace and growth assistant built on the corpus of *Lenny's Podcast* transcripts. Features a modern spatial canvas studio interface, streaming grounded responses, interactive standalone artifact creation (HTML & Markdown), Ship 30 for 30 essay generation, persistent multi-session conversation history, and heuristic routing with strict constraint enforcement.

---

## Documentation Quick Links

| Document | Description |
| :--- | :--- |
| **[PRD.md](file:///D:/oogway%20project/lenny-growth-assistant-v2/PRD.md)** | Product Requirements Document: Discovery brief, user problems, metrics, assumptions, scope, risks, acceptance criteria, and plan. |
| **[design.md](file:///D:/oogway%20project/lenny-growth-assistant-v2/design.md)** | UI/UX & Design Specification: Design tokens, component breakdown, interaction patterns, Canvas Studio paradigm, and responsiveness. |
| **[architecture.md](file:///D:/oogway%20project/lenny-growth-assistant-v2/architecture.md)** | Architecture Specification: System diagrams, data flow, PostgreSQL/pgvector schema, API endpoint catalog, retrieval pipeline, and routing. |
| **[docs/manual-test-plan.md](file:///D:/oogway%20project/lenny-growth-assistant-v2/docs/manual-test-plan.md)** | Step-by-step manual test plan with 14 test cases, exact inputs, verification commands, and expected results. |
| **[PROJECT_STRUCTURE_AUDIT.md](file:///D:/oogway%20project/lenny-growth-assistant-v2/PROJECT_STRUCTURE_AUDIT.md)** | Architectural audit of the repository cleanup, port maps, and configuration synchronizations. |
| **[agent-transcripts/](file:///D:/oogway%20project/lenny-growth-assistant-v2/agent-transcripts/)** | Genuine historical agent transcripts extracted from runtime SQLite logs (Phase 0 to Final Submission), documenting failed attempts, bug investigations, and fixes. |

---

## Why This Project Uses `LennysNewsletter/lennys-newsletterpodcastdata`

A key requirement of this project is responsible, high-fidelity transcript ingestion. The project uses the official starter dataset repository (`LennysNewsletter/lennys-newsletterpodcastdata`) rather than third-party scrapers or unverified repositories for three critical reasons:

1. **Copyright & Licensing Compliance**:
   - Lenny's Podcast transcripts are proprietary intellectual property. Lenny Rachitsky's distribution terms grant personal, non-commercial use for research while strictly prohibiting raw redistribution in public git repositories.
   - Committing raw transcript files directly into GitHub violates these redistribution terms. Instead, our project provides an automated, reproducible fetch script (`scripts/fetch_transcripts.sh`) that pulls the official files locally while ensuring `data/transcripts/` remains git-ignored.
2. **Standardized Structural Frontmatter**:
   - Alternative community scrapers often mangle speaker names, strip timestamps, or introduce web scraping noise.
   - The official dataset provides consistent YAML frontmatter (`title`, `guest`, `date`, `url`) and clean speaker turns with timestamps (`**Speaker Name** (00:15:32):`).
3. **Exact Audio Alignment & Verified Citations**:
   - Because the timestamps match the published podcast recordings, source citations rendered in the UI can direct users to the precise audio moment in the episode, creating a verified chain of custody for every claim.

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
              Internal NDJSON   |                | SQLAlchemy 2.0 (asyncpg)
                                v                v
       +------------------------+---+      +-----+---------------------+
       |     Node Agent Service     |      |  PostgreSQL 16 + pgvector  |
       | (Pi Coding Agent SDK +     |      | (Sessions, Messages,       |
       |  Ollama llama3.2:3b)       |      |  Artifacts, Embeddings)   |
       +----------------------------+      +---------------------------+
```

1. **Frontend (`/frontend`)**:
   - React 19 + TypeScript + Vite 8.
   - Modern "Midnight Slate" dark and "Warm Ivory" light themes.
   - Streaming SSE chat parser with live Markdown rendering.
   - Interactive prompt starters and quick skill pills (`✍️ Essay`, `📄 Artifact`).
   - Secure `<ArtifactViewer />` with strict `sandbox=""` iframe, inline Content-Security-Policy (CSP), and DOMPurify sanitization.
   - Off-canvas mobile navigation drawer with backdrop overlay.

2. **Backend (`/backend`)**:
   - FastAPI async service managing database persistence and transcript vector search.
   - SQLAlchemy 2.0 async engine with Alembic migrations (`0003_message_telemetry`).
   - Vector chunking with `nomic-embed-text` (768 dimensions) and cosine distance retrieval in `pgvector`.
   - Dual-layer server sanitization via Python `bleach`.
   - Internal retrieval endpoint (`POST /internal/retrieve`) authenticated with Bearer `INTERNAL_TOKEN`.

3. **Agent Service (`/agent-service`)**:
   - Node.js 24 / TypeScript service wrapping `@earendil-works/pi-coding-agent`.
   - Heuristic turn routing (`routing.ts`): classifies turns into `general`, `transcript`, or `follow_up`, toggling tools dynamically to prevent guest hallucinations.
   - Constraint engine (`constraints.ts`): parses strict numerical caps (e.g., 60 hours, ₹10,000 budget), unbuilt product status, and corrections.
   - Multi-turn conversation history management and real-time NDJSON streaming.

4. **Persistence & Models**:
   - PostgreSQL 16 with `pgvector/pgvector:pg16` for embeddings and relational entities.
   - Local Ollama runtime (`llama3.2:3b` for chat, `nomic-embed-text:latest` for embeddings).

---

## Repository Structure

```
lenny-growth-assistant-v2/
├── frontend/               # React 19 + Vite + TypeScript user interface
├── backend/                # FastAPI async backend, PostgreSQL persistence, retrieval
├── agent-service/          # Node.js/TypeScript agent runtime (Pi SDK + Ollama)
├── data/                   # Manifest & README (raw transcripts git-ignored)
├── docs/                   # Documentation & manuals
│   ├── manual-test-plan.md # 14 end-to-end manual verification test cases
│   └── reports/            # Audits, DeepSeek 50-prompt benchmark results
├── agent-transcripts/      # Genuine execution logs extracted from SQLite agent DB
├── poc/                    # Phase 0 Pi SDK & Ollama compatibility experiments (01-05)
├── scripts/                # Verification scenarios (live e2e, salon scenario, fetch)
├── docker-compose.yml      # Local multi-service orchestration (PostgreSQL + pgvector)
├── PRD.md                  # Product Requirements Document
├── design.md               # Frontend Design & UI/UX Specification
├── architecture.md         # System Architecture & Technical Specification
└── README.md               # Main project README
```

---

## Quickstart & Local Setup

### Prerequisites
- **Node.js**: >= 22.0.0 (Node 24 recommended)
- **Python**: 3.12 (with `uv` recommended)
- **Docker Desktop**: For running PostgreSQL + pgvector
- **Ollama**: Running locally on port 11434

### Step 1: Model Setup (Ollama)
Ensure the required models are pulled and ready:
```bash
# Pull chat generation model (~2.0 GB)
ollama pull llama3.2:3b

# Pull embedding model (~274 MB)
ollama pull nomic-embed-text:latest

# Verify models are listed
ollama list
```

### Step 2: Database Setup
Launch PostgreSQL with pgvector using Docker Compose:
```bash
# From project root
docker compose up -d db
```
*Default connection: `postgresql://lenny:lenny@localhost:5432/lenny_growth`*

### Step 3: Fetch Transcripts & Ingest
Fetch the official transcripts dataset and run vector ingestion:
```bash
# Option A: Run fetch script (Git Bash / WSL / Linux / macOS)
bash scripts/fetch_transcripts.sh

# Option B: Clone directly into data/transcripts
git clone https://github.com/LennysNewsletter/lennys-newsletterpodcastdata.git data/transcripts

# Run database migrations and vector ingestion
cd backend
uv venv --python 3.12
uv pip install -r requirements-dev.txt
uv run alembic upgrade head
uv run python scripts/ingest.py
cd ..
```

### Step 4: Start Backend Services
In Terminal 1 (FastAPI Backend):
```bash
cd backend
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```
- API Docs: `http://127.0.0.1:8000/docs`
- Health: `http://127.0.0.1:8000/health`

In Terminal 2 (Agent Service):
```bash
cd agent-service
npm install
npm start
```
- Health: `http://127.0.0.1:8001/health`

### Step 5: Start Frontend
In Terminal 3 (React + Vite):
```bash
cd frontend
npm install
npm run dev
```
- Web Application: `http://localhost:5173/`

---

## Running Test Suites

All subsystems contain comprehensive, passing automated test suites:

### 1. Agent Service Tests
```bash
cd agent-service
npm run test:unit    # 101 unit tests across 18 test suites
npm run typecheck    # 0 TypeScript diagnostics
```

### 2. Frontend Tests
```bash
cd frontend
npm test             # 31 passing Vitest tests
npm run typecheck    # 0 TypeScript diagnostics
npm run build        # Production bundle compiles cleanly
```

### 3. Backend Tests
```bash
cd backend
uv run python -m pytest tests -v   # 167 test items (165 passed, 2 skipped db-optional)
```

### 4. End-to-End Live Verification Scripts
```bash
# Live end-to-end scenario verification against running stack
python scripts/verify_live_scenarios.py

# Multi-turn salon business constraint verification
python scripts/verify_salon_e2e.py
```

---

## Troubleshooting Guide

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **Port 5432 Conflict** | A local PostgreSQL instance is already bound to 5432. | Stop the local PostgreSQL service (`net stop postgresql` on Windows) or update `docker-compose.yml` host port. |
| **Ollama Model Missing** | `llama3.2:3b` or `nomic-embed-text` not found. | Run `ollama pull llama3.2:3b` and `ollama pull nomic-embed-text:latest`. |
| **Vite Artifact Proxy 404** | Missing proxy entry in older configs. | `frontend/vite.config.ts` has been updated with `/artifacts` proxying to `http://127.0.0.1:8000`. |
| **Database Migrations Desync** | Alembic version mismatch on fresh DB. | Run `uv run alembic upgrade head` inside `backend/`. |
| **Internal Auth Error (401/403)** | `INTERNAL_TOKEN` mismatch between backend and agent-service. | Verify that both `backend/.env` and `agent-service/.env` have matching `INTERNAL_TOKEN=dev-internal-token`. |

---

## Security & Sanitization Architecture

- **Dual-Layer Sanitization**: Python `bleach` server-side tag whitelist combined with client-side `DOMPurify` before DOM insertion.
- **Strict Iframe Sandboxing**: Rendered deliverables live inside an `<iframe>` with `sandbox=""` (blocking scripts, popups, and cookies).
- **Content Security Policy (CSP)**: `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data: https:;`
- **Zero Secret Leakage**: All `.env` files are git-ignored; generic placeholders are used in `.env.example`.
