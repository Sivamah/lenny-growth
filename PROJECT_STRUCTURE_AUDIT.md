# Lenny Growth Assistant V2 — Project Structure Audit, Cleanup and Verification Report

**Auditor:** Senior Software Architect & Full-Stack Engineer  
**Date:** October 12, 2026  
**Project Root:** `D:\oogway project\lenny-growth-assistant-v2`  
**Git Remote:** `https://github.com/Sivamah/lenny-growth.git`  
**Reference Repository:** `D:\lenny-growth-assistant-main` (Inspected as reference only; 100% untouched)

---

## 1. Original Architecture

The application is structured as a decoupled, production-grade microservice architecture:

```
                      +-----------------------------------+
                      |       React + Vite Frontend       |
                      |    (Lenny Growth Studio Canvas)   |
                      +-----------------+-----------------+
                                        | SSE / REST
                                        v
                      +-----------------+-----------------+
                      |         FastAPI Backend           |
                      | (Session Persistence + Retrieval) |
                      +--------+----------------+---------+
                               |                |
             Internal NDJSON   |                | SQLAlchemy 2.0 (async)
             (X-Internal-Token)|                v
                               v      +---------+-----------------+
      +------------------------+---+  | PostgreSQL 16 + pgvector  |
      |     Node Agent Service     |  | (Sessions, Messages,       |
      |  (Pi Coding Agent SDK +    |  |  Artifacts, Embeddings)   |
      |   Ollama llama3.2:3b)      |  +---------------------------+
      +----------------------------+
```

### Component Roles & Communication Paths

1. **Frontend (`frontend/`)**:
   - Built with React 19, TypeScript 5.7, and Vite 8.
   - Consumes backend via REST (`/health`, `/api/config`, `/sessions`) and SSE (`POST /api/chat`).
   - Renders live markdown streams, citations, grounding signals, and token usage telemetry.
   - Includes **ArtifactViewer** with defense-in-depth security: client-side DOMPurify sanitization, sandboxed iframe (`sandbox=""`), and restrictive Content-Security-Policy (CSP).

2. **FastAPI Backend (`backend/`)**:
   - Asynchronous Python 3.12 service with SQLAlchemy 2.0 and asyncpg.
   - Exposes `/api/chat` which orchestrates turn persistence, connects to the Node agent-service via internal NDJSON streaming, and relays Server-Sent Events to the frontend.
   - Implements internal vector retrieval (`POST /internal/retrieve`) backed by PostgreSQL pgvector (768 dimensions) and Ollama `nomic-embed-text`.
   - Protects internal routes with timing-safe `X-Internal-Token` authentication (`secrets.compare_digest`).
   - Applies server-side HTML/Markdown sanitization via Bleach and tinycss2 before persisting or serving artifacts.

3. **Node Agent Service (`agent-service/`)**:
   - Node.js 24 + TypeScript service wrapping `@earendil-works/pi-coding-agent` SDK (v1.1.0).
   - Manages model sessions (Ollama `llama3.2:3b` default; optional Anthropic Claude adapter).
   - Controls tool execution: dynamically exposes `search_transcripts` for transcript questions and disables it for general advice and programming questions to prevent false citations.
   - Implements specialized turn pipelines:
     - `ship30_essay`: Buffered drafting with structural review, word count enforcement, and automated retry on failure.
     - `artifact`: Standalone artifact synthesis with tool-leakage scrubbing and title extraction.

4. **Data Infrastructure (`docker-compose.yml`)**:
   - PostgreSQL 16 container with `pgvector/pgvector:pg16`.
   - 3 Alembic migration revisions (`0001_initial`, `0002_chunk_metadata`, `0003_message_telemetry`).

---

## 2. Actual Problems Found, Evidence & Impact

| # | File / Directory | Actual Problem Found | Evidence & Root Cause | Impact |
|---|---|---|---|---|
| **P1** | Project Root (`/`) | Cluttered root directory with internal audit reports and large benchmark results. | 5 files at root: `CHAT_RESPONSE_QUALITY_REPORT.md`, `DEEPSEEK_INDEPENDENT_AUDIT.md`, `FINAL_SUBMISSION_READINESS_REPORT.md`, `UI_REDESIGN_AND_DEBUG_REPORT.md`, and `DEEPSEEK_50_PROMPT_RESULTS.json` (90 KB). | Unprofessional project root; mixes ephemeral benchmark artifacts with essential project code. |
| **P2** | `frontend/vite.config.ts` | Missing `/artifacts` route in Vite development proxy table. | `proxy` configuration contained `/health`, `/api`, and `/sessions`, but omitted `/artifacts`. Frontend `api.getArtifact(id)` fetches `/artifacts/${id}`. | In Vite proxy mode (`VITE_API_BASE_URL=""`), loading standalone artifacts directly returns a 404 or SPA fallback HTML instead of backend data. |
| **P3** | `.env.example` (Root) | Password mismatch with backend default connection string. | Root `.env.example` specified `POSTGRES_PASSWORD=change-me-locally`, while `backend/.env.example` and `docker-compose.yml` default to `lenny`. | Developers following setup docs by copying root `.env.example` suffered connection rejection from PostgreSQL. |
| **P4** | `backend/.env.example` vs `agent-service/.env.example` | Internal authentication token comment mismatch. | `agent-service/.env.example` specifies `INTERNAL_TOKEN=dev-internal-token`, while `backend/.env.example` had `# INTERNAL_TOKEN=change-me`. | If a developer uncomments the token on backend without manual synchronization, internal API calls fail with `401 Unauthorized`. |
| **P5** | `poc/src/` | Obsolete scratch probe files left from exploratory Phase 0 work. | Files `check.ts`, `inspect.ts`, `test-bad.ts`, `test-bad2.ts`, `test-bad3.ts`, `test-bad4.ts` were iterative scratch scripts not referenced in `package.json` or `RESULTS.md`. | Dead code clutter that causes confusion during code review. |
| **P6** | `frontend/` & `agent-service/` | Transient runtime logs left in tree. | `frontend/audit-50.log` (5.6 KB past benchmark log) and `agent-service/agent-restarted.log`. | Non-source files polluting repository history. |
| **P7** | `README.md` | Outdated test suite statistics and missing directory map. | README stated "28 passing Vitest tests", "37 passing tests across 5 suites", and "98 test items (96 passed)". Current actual counts are 31, 101, and 167. | Inaccurate documentation misleads reviewers on actual test coverage. |

---

## 3. Confirmed Issues vs. Investigated Potential Concerns

### Confirmed Issues (Addressed)
- **Vite Proxy `/artifacts` Gap**: Confirmed and fixed in `frontend/vite.config.ts`.
- **Environment Password Divergence**: Confirmed and aligned in root `.env.example`.
- **Root Report Sprawl**: Confirmed and consolidated under `docs/reports/`.
- **Obsolete PoC Debug Scripts**: Confirmed as unreferenced scratch files and pruned.
- **Documentation Drift**: Confirmed and updated in `README.md`.

### Investigated Potential Concerns (Verified Sound & Preserved)
- **Agent Client Duplication**:
  - *Concern*: Existence of both `backend/app/services/agent_client.py` and `backend/app/agent/node_client.py`.
  - *Investigation*: `AgentServiceClient` provides lightweight HTTP URL construction, headers, and the non-blocking `/v1/health` probe. `NodeAgentClient` manages the long-lived streaming connection, NDJSON line iteration, abort signaling, and lifecycle cleanup.
  - *Verdict*: **Clean separation of concerns. Retained as-is.**
- **Vector Embedding Sizing**:
  - *Concern*: Potential mismatch between embedding model, SQLAlchemy column, and Alembic migration.
  - *Investigation*: Verified `Vector(768)` in migration `0001_initial_schema.py`, `chunks.embedding Vector(settings.embedding_dimensions)` in `models.py`, `EMBEDDING_DIMENSIONS=768` in `config.py`, and `nomic-embed-text` output length (768).
  - *Verdict*: **100% mathematically and schema-consistent.**
- **Database Resilience**:
  - *Concern*: Whether FastAPI crashes on startup if PostgreSQL is stopped.
  - *Investigation*: `lifespan` in `main.py` uses `check_database()` with a fast 3-second connect timeout and logs a warning instead of raising. `GET /health` reports `"status": "degraded"` with `"database": { "reachable": false }`.
  - *Verdict*: **Production-grade degradation behavior. Retained.**

---

## 4. Changes Made and Justifications

1. **Created `docs/reports/` and Organized Documentation**:
   - Moved internal markdown reports and benchmark output (`CHAT_RESPONSE_QUALITY_REPORT.md`, `DEEPSEEK_INDEPENDENT_AUDIT.md`, `FINAL_SUBMISSION_READINESS_REPORT.md`, `UI_REDESIGN_AND_DEBUG_REPORT.md`, and `DEEPSEEK_50_PROMPT_RESULTS.json`) to `docs/reports/`.
   - Updated `frontend/scripts/audit-50-prompts.ts` so `RESULTS_PATH` defaults to `docs/reports/DEEPSEEK_50_PROMPT_RESULTS.json`.
   - Updated cross-references in `DEEPSEEK_INDEPENDENT_AUDIT.md`.
   - *Justification*: Restores standard repository hygiene without losing valuable benchmark artifacts.

2. **Added `/artifacts` to Vite Dev Proxy**:
   - In `frontend/vite.config.ts`, added `"/artifacts": { target: backendTarget, changeOrigin: true }`.
   - *Justification*: Ensures direct artifact fetching works seamlessly in development mode without CORS or 404 errors.

3. **Synchronized `.env.example` Templates**:
   - Root `.env.example`: Set default `POSTGRES_PASSWORD=lenny` to match backend's default `DATABASE_URL` and `docker-compose.yml`.
   - `backend/.env.example`: Updated commented example token to `dev-internal-token` to match `agent-service/.env.example`.
   - *Justification*: Prevents out-of-the-box configuration and connection failures.

4. **Removed Obsolete PoC Scratch Files**:
   - Removed `check.ts`, `inspect.ts`, `test-bad.ts`, `test-bad2.ts`, `test-bad3.ts`, and `test-bad4.ts` from `poc/src/`.
   - Deleted temporary logs `frontend/audit-50.log` and `agent-service/agent-restarted.log`.
   - *Justification*: Eliminates unreferenced dead code while preserving the complete documented PoC suite.

5. **Updated `README.md`**:
   - Added complete repository directory diagram.
   - Updated test commands and verified numbers across all three test suites.
   - Documented transcript ingestion, verification scripts, and security sanitization.
   - *Justification*: Provides clear, accurate, and reproducible onboarding for evaluators.

---

## 5. Files and Directories Intentionally Retained

- **`poc/` (Phase 0 Suite)**: Retained `01-minimal.ts`, `02-tool.ts`, `03-ollama.ts`, `04-anthropic.ts`, `05-errors-abort.ts`, `common.ts`, `agentdir/models.json`, `agentdir/models-bad.json`, `package.json`, and `RESULTS.md`. These constitute the documented evidence verifying SDK and Ollama compatibility.
- **`data/corpus_manifest.json` & `data/README.md`**: Retained. Explains transcript curation, word counts, and data licensing constraints.
- **`scripts/fetch_transcripts.sh`**: Retained. Allows compliant fetching of raw podcast data on demand.
- **`scripts/verify_live_scenarios.py` & `scripts/verify_salon_e2e.py`**: Retained. Comprehensive end-to-end regression validation tools for live deployment.
- **`backend/migrations/`**: Retained all Alembic migration scripts (`0001_initial`, `0002_chunk_metadata`, `0003_message_telemetry`).

---

## 6. Files Removed or Moved

| Action | Path | Justification |
|---|---|---|
| **MOVED** | `CHAT_RESPONSE_QUALITY_REPORT.md` → `docs/reports/` | Internal evaluation report; moved to standard docs directory. |
| **MOVED** | `DEEPSEEK_INDEPENDENT_AUDIT.md` → `docs/reports/` | Internal benchmark audit; moved to standard docs directory. |
| **MOVED** | `FINAL_SUBMISSION_READINESS_REPORT.md` → `docs/reports/` | Final review checklist; moved to standard docs directory. |
| **MOVED** | `UI_REDESIGN_AND_DEBUG_REPORT.md` → `docs/reports/` | UI audit report; moved to standard docs directory. |
| **MOVED** | `DEEPSEEK_50_PROMPT_RESULTS.json` → `docs/reports/` | 90 KB benchmark data dump; relocated alongside its audit report. |
| **DELETED** | `poc/src/check.ts` | Obsolete Phase 0 scratch debug script. |
| **DELETED** | `poc/src/inspect.ts` | Obsolete Phase 0 scratch debug script. |
| **DELETED** | `poc/src/test-bad.ts` | Superseded by official `05-errors-abort.ts`. |
| **DELETED** | `poc/src/test-bad2.ts` | Superseded by official `05-errors-abort.ts`. |
| **DELETED** | `poc/src/test-bad3.ts` | Superseded by official `05-errors-abort.ts`. |
| **DELETED** | `poc/src/test-bad4.ts` | Superseded by official `05-errors-abort.ts`. |
| **DELETED** | `frontend/audit-50.log` | Ephemeral test output buffer. |
| **DELETED** | `agent-service/agent-restarted.log` | Ephemeral runtime restart log. |

---

## 7. Test Verification & Actual Results

All tests were executed and recorded before and after cleanup:

### Subsystem 1: Node Agent Service
- **Typecheck**: `npm run typecheck`  
  *Result*: **Passed** (`tsc -p tsconfig.json --noEmit` exited with 0 diagnostics).
- **Unit & Regression Suite**: `npm run test:unit`  
  *Result*: **101 tests passed across 18 suites (0 failed, 0 cancelled, 0 skipped, duration 3.77s)**.  
  *Coverage*: Router classification (general vs. transcript vs. follow-up), session history distillation, wire event mapping, transcript tool execution & mock fallback, Ship 30 essay validation & single-retry loop, and the 12-scenario response quality suite.

### Subsystem 2: Frontend
- **Typecheck**: `npm run typecheck`  
  *Result*: **Passed** (`tsc -b --noEmit` exited with 0 diagnostics).
- **Vitest Suite**: `npm test`  
  *Result*: **31 passed across 5 test files (duration 2.27s)**.  
  *Coverage*: API client error handling, SSE buffer parsing & incremental streaming, Composer state & abort triggers, MessageBubble citation rendering, ArtifactViewer DOMPurify & iframe sandboxing.
- **Production Build**: `npm run build`  
  *Result*: **Built successfully** in 205ms (282 modules transformed, gzip size: 149.77 kB JS, 5.76 kB CSS).

### Subsystem 3: FastAPI Backend
- **Pytest Suite**: `uv run python -m pytest tests -v`  
  *Result*: **165 passed, 2 skipped, 0 failed in 138.61s**.  
  *Coverage*: Agent client protocol, input schema validation, Bleach HTML/Markdown sanitization, chat orchestration & abort persistence, chunking, embeddings, health check reachability, and session management.  
  *(Note: The 2 skipped tests are live-database tests `test_database_optional.py` and `test_grounding_calibration.py`, which are conditionally skipped when PostgreSQL is not running).*

---

## 8. Unresolved Issues & Runtime Requirements

1. **Docker Container Dependency**: PostgreSQL 16 + pgvector must be started via `docker compose up -d db` for full multi-turn persistence and live pgvector queries.
2. **Local LLM Availability**: Ollama must be running locally (`http://localhost:11434`) with `llama3.2:3b` and `nomic-embed-text` pulled for live AI completions and embeddings generation.

---

## 9. Recommended Submission Structure

```
lenny-growth-assistant-v2/
├── .env.example                  # Synchronized root Docker environment template
├── .gitignore                    # Comprehensive ignore rules (secrets, venvs, dist, logs)
├── docker-compose.yml            # PostgreSQL 16 + pgvector container definition
├── README.md                     # Comprehensive setup, running, and testing guide
├── PROJECT_STRUCTURE_AUDIT.md    # This architectural audit report
├── agent-service/                # Node.js/TypeScript Pi Agent runtime
│   ├── .env.example
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/                      # Runtime, routing, chat, essay, artifact, tools
│   ├── tests/                    # 101 unit tests across 18 suites
│   └── agentdir/                 # Pi SDK model catalog definitions
├── backend/                      # FastAPI persistence and retrieval service
│   ├── .env.example
│   ├── requirements.txt
│   ├── requirements-dev.txt
│   ├── alembic.ini
│   ├── app/                      # Routes, schemas, db models, services, orchestrator
│   ├── migrations/               # Alembic revisions 0001, 0002, 0003
│   ├── scripts/                  # Data ingestion CLI
│   └── tests/                    # 167 backend test items
├── data/                         # Corpus metadata
│   ├── corpus_manifest.json
│   └── README.md
├── docs/                         # Consolidated documentation & audits
│   └── reports/
│       ├── CHAT_RESPONSE_QUALITY_REPORT.md
│       ├── DEEPSEEK_50_PROMPT_RESULTS.json
│       ├── DEEPSEEK_INDEPENDENT_AUDIT.md
│       ├── FINAL_SUBMISSION_READINESS_REPORT.md
│       └── UI_REDESIGN_AND_DEBUG_REPORT.md
├── frontend/                     # React 19 + Vite 8 user interface
│   ├── .env.example
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts            # Proxy table incl. /artifacts
│   ├── src/                      # Components, API clients, styles, types
│   └── scripts/                  # Live audit test harness
├── poc/                          # Phase 0 Pi SDK compatibility suite
│   ├── package.json
│   ├── RESULTS.md
│   ├── agentdir/
│   └── src/                      # 01-minimal through 05-errors-abort
└── scripts/                      # Live verification scenarios
    ├── fetch_transcripts.sh
    ├── verify_live_scenarios.py
    └── verify_salon_e2e.py
```

---

## 10. Final Assessment

The Lenny Growth Assistant V2 project is:
- **Architecturally Sound**: Clear separation between UI presentation, backend persistence/retrieval, and Node.js agent orchestration.
- **Secure**: Robust two-tier sanitization (Bleach on server, DOMPurify + strict sandboxed iframe on client) with no exposed credentials.
- **Verifiably Functional**: 100% of available test suites (101 agent tests, 31 frontend tests, 165 backend tests) pass cleanly without regressions.
- **Clean & Organized**: No temporary logs or obsolete scratch files remain; all reports are properly structured in `docs/reports/`.
- **Verdict**: **READY FOR SUBMISSION**.
