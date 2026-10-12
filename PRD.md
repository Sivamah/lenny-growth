# Product Requirements Document (PRD)
## Lenny Growth Assistant V2 (Lenny Growth Studio)

**Author:** Forward Deployed Engineer  
**Status:** Implemented & Verified  
**Target Release:** Take-Home Final Submission  
**Last Updated:** October 2026  

---

## 1. Discovery Brief

### 1.1 Background
*Lenny's Podcast* is a premier resource in tech, product management, and growth marketing, featuring deep-dive conversations with world-class practitioners (e.g., Elena Verna, Jason Cohen, Brian Halligan, Evan Spiegel, Marc Andreessen). The show's archive spans hundreds of hours of tactical advice, frameworks, and case studies. However, navigating this extensive unstructured knowledge base is time-consuming and inefficient for practitioners facing urgent tactical challenges.

### 1.2 Vision
The **Lenny Growth Assistant V2 (Lenny Growth Studio)** is an AI research workspace that transforms Lenny's podcast transcript corpus into an interactive, grounded advisor. It provides:
1. Grounded answers citing exact guest quotes, episodes, timestamps, and episode URLs.
2. Natural, unconstrained conversation on general business, productivity, and programming queries without false tool invocations.
3. Interactive, standalone **Artifacts** (HTML visual reports, OKR templates, growth loop canvases) rendered securely.
4. Structured **Ship 30 for 30** essays evaluated through an automated multi-step quality review.
5. Strict adherence to user-provided practical and financial constraints (time budgets, monetary caps, unbuilt product realities).

---

## 2. User Problem

### 2.1 Target Personas
- **Early-Stage Founders:** Need fast, battle-tested playbooks for pricing, customer acquisition, and product-market fit without hiring expensive consultants.
- **Product Managers & Growth Leads:** Seek concrete frameworks (e.g., retention loops, pricing experiments, PLG motions) backed by direct quotes from industry leaders.
- **Aspiring Founders & Engineers:** Require actionable weekly execution plans that respect strict constraints (e.g., 60 hours total time, ₹10,000 budget, pre-product discovery).

### 2.2 Core Pain Points
1. **Hallucination & Fake Citations:** Generic LLMs invent quotes, attribute ideas to the wrong guests, or fabricate episodes.
2. **Context Bleed & Over-Retrieval:** Many RAG systems trigger vector search on every turn, dragging irrelevant transcript fragments into simple programming or general productivity discussions.
3. **Constraint Blindness:** Small local models frequently allocate 80–100+ hours of tasks when given a strict 60-hour constraint, or suggest "free trials" for products that have not yet been built.
4. **Tool-Call Leakage:** Small models occasionally dump raw JSON function calls (`{"name": "search_transcripts", "arguments": ...}`) directly into user chat streams.
5. **Static, Text-Only Responses:** Complex frameworks (like OKRs or growth loops) are difficult to parse in markdown chat bubbles and benefit from structured visual artifacts.

---

## 3. Success Metrics

| Metric | Target | Measurement Method |
|---|---|---|
| **Grounding Precision** | 100% genuine citations | Citations strictly point to verified chunks in the database; zero fabricated URLs. |
| **Routing Accuracy** | > 95% classification | General and programming questions route to `general`; transcript queries route to `transcript`. |
| **Constraint Compliance** | 100% adherence | Total plan hours $\le$ specified limit; pre-product ideas use discovery/concierge methods, not fake trials. |
| **Tool-Call Leak Rate** | 0.0% leaks to user | Leaked JSON tool signatures are automatically intercepted, stripped, or recovered before rendering. |
| **Security Sanitization** | 100% exploit neutralization | Active XSS vectors (`<script>`, inline handlers, `javascript:` URIs) neutralized at write and read boundaries. |
| **Test Suite Pass Rate** | 100% of unit/integration tests | All backend, agent-service, and frontend automated tests pass cleanly. |

---

## 4. Assumptions

1. **Local Privacy & Offline Feasibility:** Primary execution utilizes local Ollama models (`llama3.2:3b` for chat, `nomic-embed-text` for 768-dimensional embeddings) to ensure zero third-party data leakage and zero API costs during local evaluation.
2. **PostgreSQL & Vector Extension:** PostgreSQL 16 with `pgvector` runs via Docker Compose or native service on `localhost:5432`.
3. **Node.js Agent SDK:** The agent runtime is powered by `@earendil-works/pi-coding-agent` (v1.1.0) running in Node.js >= 22.
4. **Data Licensing:** The raw transcript dataset is subject to personal non-commercial licensing; therefore, raw transcripts are git-ignored and ingested locally via scripts rather than committed to version control.

---

## 5. Scope

### 5.1 In-Scope
- **Dual-Role Conversational Agent:** Seamlessly handles both general conversational advisory (no tools) and transcript-grounded inquiry (active retrieval).
- **Hybrid Vector Retrieval Pipeline:** Chunking (280 tokens, 40-token overlap), Ollama embeddings (768-dim), cosine distance search, and calibrated grounding score thresholding (`RETRIEVAL_MIN_SCORE = 0.60`).
- **Citation Badges:** UI components displaying guest name, episode title, timestamp, source link, and relevant quote snippet.
- **Constraint Enforcement Engine:** Extracts numeric hour caps, monetary budgets, and pre-product flags; validates drafts; triggers targeted corrective retries on violations.
- **Artifact Creation & Security:** Generates standalone HTML and Markdown reports; renders inside a sandboxed iframe (`sandbox=""`) protected by a strict Content-Security-Policy (CSP) and server-side Bleach sanitization.
- **Ship 30 for 30 Essay Skill:** Generates structured essays with word count validation, headings, bold emphasis, and takeaways, backed by an automated single-retry correction pass.
- **Session Persistence & Isolation:** Full session CRUD (`POST`, `GET`, `PATCH`, `DELETE`) with complete isolation between conversations.
- **Mid-Turn Abort:** Best-effort cancellation via UI Stop button with persistent preservation of partial generated responses.

### 5.2 Out-of-Scope
- Commercial redistribution or hosting of raw Lenny Podcast transcripts.
- Multi-user authentication, OAuth, or RBAC (internal token model suffices for single-user take-home).
- Live audio transcription or speech-to-text processing.
- Autonomous web browsing or external internet scraping.

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation Strategy |
|---|---|---|
| **Small Model Arithmetic Errors** | `llama3.2:3b` over-allocates time budgets while claiming compliance. | **Dual-layer constraint engine:** Injects explicit turn-level guardrails requiring step-by-step arithmetic addition, checks total hours programmatically, and triggers an actionable retry if exceeded. |
| **Tool-Call JSON Leakage** | Raw function calls leak into the assistant chat text. | **Lexical Leak Recovery:** Detects `{ "name": "search_transcripts" }` patterns in model text, strips leaked blocks, or synthesizes an evidence summary if the draft is unrecoverable. |
| **Malicious Stored Artifacts (XSS)** | Model generates malicious HTML tags or script injection. | **Defense in Depth:** Server-side sanitization using Bleach + tinycss2 allow-list on both write and read paths; client-side DOMPurify sanitization; iframe sandboxed with `sandbox=""` and restrictive CSP. |
| **Database Unavailability on Boot** | Fast startup fails if Docker is not yet running. | **Graceful Degradation:** SQLAlchemy engine connects lazily; startup probes log warnings rather than crashing; `/health` reports `"status": "degraded"` with 200 HTTP status code. |

---

## 7. Acceptance Criteria

### AC 1: Normal Chat (No Tools)
- Given a general productivity or programming prompt (e.g., *"How can I stop procrastinating?"* or *"Explain Java ArrayList"*),
- When submitted to `/api/chat`,
- Then the agent routes to `general`, does not call `search_transcripts`, emits zero citations, and answers directly.

### AC 2: Transcript Retrieval & Grounding
- Given a question asking what Lenny's Podcast or a guest said about a topic (e.g., *"What did Jason Cohen say about pricing?"*),
- When submitted to `/api/chat`,
- Then the agent invokes `search_transcripts`, emits citations with guest, episode title, timestamp, and URL, and marks `grounded: true`.

### AC 3: Unsupported Topic Handling
- Given a query about a topic absent from the podcast (e.g., *"What did the podcast say about quantum computing?"*),
- When processed,
- Then the agent evaluates `grounded: false` and explicitly admits that the podcast transcripts do not cover the topic without hallucinating citations.

### AC 4: Constraint Enforcement & Follow-Up Correction
- Given a business prompt specifying a strict 60-hour total limit and an unbuilt product,
- When the assistant outputs a plan,
- Then the total time allocated does not exceed 60 hours, and the strategy relies on discovery/concierge validation rather than unbuilt software trials.
- When the user challenges a mistake in a follow-up turn, the model acknowledges and corrects the error directly.

### AC 5: Secure Artifact Generation
- Given a prompt requesting a standalone visual HTML report or growth framework,
- When generated,
- Then the artifact is stored in the `artifacts` table, sanitized on write and read, and rendered inside a secure sandboxed iframe with active scripts neutralized.

### AC 6: Session Isolation
- Given active Session A and fresh Session B,
- When Session B is queried,
- Then Session B has no access to the context, messages, or constraints of Session A. Deleting Session A has zero impact on Session B.

---

## 8. Implementation Plan & Delivery Phases

- **Phase 0 — SDK & Model Feasibility:** Verify Pi Coding Agent SDK 1.1.0 with Ollama `llama3.2:3b`. Completed and documented in `poc/RESULTS.md`.
- **Phase 1 — Core Architecture Foundation:** FastAPI async service, PostgreSQL 16 + pgvector schema, Alembic migrations, Node.js agent service turn streaming, and Ollama embeddings.
- **Phase 2 — UI/UX Studio Redesign:** React 19 + Vite canvas workspace, streaming SSE parser, ArtifactViewer with strict CSP, and responsive mobile-first styling.
- **Phase 3 — Quality Hardening & Leak Interception:** Dual-role system prompt, leak detection/recovery, and Ship 30 essay automated review pipeline.
- **Phase 4 — Constraint Engine & Follow-Up Reasoning:** Numerical constraint extraction, concierge/discovery validation for unbuilt products, and 12-scenario regression suite.
- **Phase 5 — Server-Side Security Hardening:** Bleach + tinycss2 write-time and read-time artifact sanitization.
- **Phase 6 — Repository Audit, Cleanup & Submission Readiness:** Directory structure cleanup, `.env.example` alignment, Vite proxy completion, and end-to-end regression validation.
