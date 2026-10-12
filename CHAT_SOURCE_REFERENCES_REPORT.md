# Chat Source References & Inline Citation Pipeline Report

**Project:** Lenny Growth Assistant V2  
**Date:** October 12, 2026  
**Status:** Completed & Verified  

---

## 1. Executive Summary

Lenny Growth Assistant V2 now features **accurate, clickable inline citation references (`[1]`, `[2]`)** inside assistant chat messages with an **expandable, structured Sources section** below each response.

### Core Experience Delivered
1. **Accurate Inline Citation Markers**: Factual claims sourced from the Lenny transcript corpus include inline citations `[1]`, `[2]` placed adjacent to the claims.
2. **Interactive UI Connections**: Clicking an inline marker jumps smoothly to and highlights the corresponding source card with an accent pulse animation.
3. **Rich Metadata**: Source cards display the 1-indexed badge `[1]`, episode title, actual speaker (e.g. `Jason Cohen`), start timestamp (e.g. `00:47:35`), similarity score (`★ 0.74`), and verified external URL `↗` when present.
4. **Expandable Plain-Text Excerpts**: Relevant transcript snippets are displayed as plain text (neutralizing any potential script or HTML tags) with a "Show full excerpt ▾" / "Show less ▴" toggle for long passages.
5. **Strict Distinction Between General & Transcript Chat**:
   - **General Questions** (e.g. Java programming, productivity advice): Answered directly using general model knowledge, zero unnecessary transcript retrieval, zero citations, and zero fabricated sources.
   - **Transcript Questions** (e.g. podcast guests, retention, pricing): Grounded in pgvector search; only real retrieved chunks are cited.
   - **Unsupported Questions** (e.g. quantum computing): Corpus gaps are communicated with explicit uncertainty; `grounded=false` suppresses citations to avoid hallucination.

---

## 2. Citation Pipeline Architecture & Traceability

Source metadata travels through the stack without loss across 6 decoupled stages:

```
[PostgreSQL + pgvector]
   │ (c.start_speaker, c.start_timestamp, c.content, t.title, t.guest, t.source_url)
   ▼
[FastAPI Retriever Service]
   │ maps speaker = c.start_speaker or t.guest; validates cosine similarity score
   ▼
[POST /internal/retrieve]
   │ returns RetrieveResponse: { grounded, max_score, results: [RetrievedChunkModel] }
   ▼
[Node Agent Service]
   │ - routing.ts: routes to 'general', 'transcript', or 'follow_up'
   │ - search-transcripts.ts tool: instructs model to cite chunks as [1], [2]
   │ - session-pool.ts: system prompt reinforces numbered claim citations
   │ - events.ts: extractCitationsFromResult maps index (1..N), speaker, timestamp, snippet
   ▼
[SSE Chat Stream (POST /api/chat)]
   │ events: turn_start -> text_delta -> citations -> grounding -> turn_end
   ▼
[React Frontend]
   │ - linkifyCitationMarkers: converts prose [1] -> [1](#source-1) (skips code blocks)
   │ - ReactMarkdown: custom 'a' renders <button class="citation-ref-btn">[1]</button>
   │ - Citations.tsx: renders card id="source-{msgId}-1" with speaker pill, timestamp,
   │   expandable text snippet, and jump-highlight state
```

### Traceability Details
- **Chunk Identification**: Chunks maintain unique UUIDs (`chunk_id`) from the PostgreSQL `chunks` table.
- **Speaker Attribution**: Uses `c.start_speaker` from the chunk timestamp boundaries. If a chunk begins without a speaker label, it falls back to the episode's `t.guest`.
- **Timestamp Tracking**: Exact MM:SS or HH:MM:SS timestamps are preserved directly from `c.start_timestamp`.
- **Confidence Calibration**: Responses with `score < 0.60` (or `grounded=false`) automatically suppress citations to prevent hallucinating loose topic matches as verified evidence.

---

## 3. Root Causes of Missing / Incorrect References & Fixes

| Area | Root Cause | Implemented Solution |
| :--- | :--- | :--- |
| **Backend SQL** | `retriever.py` selected `c.id`, `c.content`, `c.start_timestamp`, but omitted `c.start_speaker` from SQL query. | Added `c.start_speaker` to `_search_postgres` and fallback queries, populating `speaker = row.get("start_speaker") or row.get("guest")`. |
| **Backend Schemas** | `RetrievedChunkModel` schema lacked a dedicated `speaker` field. | Added `speaker: str \| None = None` to `RetrievedChunkModel` in `backend/app/schemas/retrieval.py`. |
| **Agent Event Mapping** | `extractCitationsFromResult` in `events.ts` did not assign numbered indices `1..N` or preserve `speaker`. | Populated `index: idx + 1`, `chunk_id`, and `speaker` (with fallback chain: `chunk.speaker ?? chunk.start_speaker ?? chunk.guest`). |
| **Agent Prompting** | Model lacked explicit instructions to place bracketed numbered citations `[1]`, `[2]` after factual statements. | Added prompt guidelines in `search-transcripts.ts` and `session-pool.ts` instructing the LLM to place numbered markers matching search result order. |
| **Frontend Markdown** | ReactMarkdown rendered plain `[1]` as literal prose without interactivity or anchor links. | Added `linkifyCitationMarkers()` to convert prose `[1]` to `[1](#source-1)` (preserving code fences), and rendered custom accessible `<button className="citation-ref-btn">`. |
| **Frontend Sources UI** | Sources displayed a single flat block without expandable excerpts, speaker metadata, or jump highlighting. | Redesigned `Citations.tsx` with numbered badges, speaker badge, timestamp pill, expandable plain-text excerpt, and interactive highlight pulses. |
| **XSS & Link Security** | Unsanitized external links could accept dangerous protocols (`javascript:`). | Added `isValidHttpUrl()` validation allowing only `http:` and `https:`. Rendered excerpts as plain JSX text nodes to prevent HTML injection. |

---

## 4. Files Changed

### Backend (`FastAPI`)
1. **`backend/app/schemas/retrieval.py`**
   - Added `speaker: str | None = None` to `RetrievedChunkModel`.
2. **`backend/app/services/retriever.py`**
   - Updated `RetrievedChunk` dataclass with `speaker: str | None = None`.
   - Updated `_search_postgres` and `_search_fallback` queries to select `c.start_speaker` and map `speaker=row.get("start_speaker") or row.get("guest")`.

### Agent Service (`Node.js / TypeScript`)
3. **`agent-service/src/retrieval.ts`**
   - Added `speaker?: string;` to `RetrievalChunk` interface.
4. **`agent-service/src/events.ts`**
   - Added `index?: number; chunk_id?: string; speaker?: string;` to `Citation` and `RetrievalChunkLike`.
   - Updated `extractCitationsFromResult` to assign 1-based `index`, preserve `chunk_id`, and resolve `speaker`.
5. **`agent-service/src/tools/search-transcripts.ts`**
   - Updated `promptGuidelines` instructing LLMs to cite retrieved results with bracketed numbers `[1]`, `[2]`.
6. **`agent-service/src/session-pool.ts`**
   - Updated transcript system prompt with inline citation rules.
7. **`agent-service/tests/events.test.ts`**
   - Added unit regression tests asserting `extractCitationsFromResult` populates 1-based index, speaker, and chunk IDs correctly.

### Frontend (`React / TypeScript / CSS`)
8. **`frontend/src/types.ts`**
   - Added `index?: number; speaker?: string | null; chunk_id?: string;` to `Citation` interface.
9. **`frontend/src/components/Citations.tsx`**
   - Redesigned citation list into expandable source cards with `[N]` index badge, speaker badge, timestamp pill, plain-text excerpt with toggle, safe external link, and highlight support.
10. **`frontend/src/components/MessageBubble.tsx`**
    - Added `linkifyCitationMarkers()` utility.
    - Added custom link renderer transforming `#source-N` anchors into accessible buttons with smooth scroll and auto-expansion.
11. **`frontend/src/components/MessageBubble.test.tsx`**
    - Added comprehensive regression tests covering inline buttons, multi-citations, code block protection, missing metadata, plain-text XSS prevention, and invalid link blocking.
12. **`frontend/src/styles/global.css`**
    - Added styles for `.citation-ref-btn`, `.citations__index`, `.citations__meta-pill`, `.citations__expand-btn`, `.citations__item.is-highlighted`, and citation pulse animation.

---

## 5. Example Answers Before vs After

### Example 1: Transcript-Specific Question
**Question:** *"What did Jason Cohen say about raising prices and changing customer segments?"*

#### Before
> **Assistant:** Raising prices means you need to satisfy enterprise customers with security and governance.
> *(No inline markers in text. Flat citation box showing only episode title and no speaker, timestamp, or expand action).*

#### After
> **Assistant:** Jason Cohen mentions that raising prices and changing customer segments requires a strategic decision that is part of the whole strategy, and not just a simple knob to turn [1]. He also notes that even if a company wants to raise prices, they need to consider the new demands of the new customers, such as security, governance, and professional services [1].
>
> **🎙️ Sources (1)**
> **[1] 5 questions to ask when your product stops growing | Jason Cohen (2x unicorn founder)**
> - 👤 Speaker: **Jason Cohen**
> - ⏱ **00:49:05** · ★ 0.74 relevance
> - Excerpt: *"It gets easier. I don't want to go off too much of a tangent, but the thing you have to remember about raising prices is..."*  
>   [Show full excerpt ▾]

---

### Example 2: General Knowledge Question
**Question:** *"Explain the difference between an array and an ArrayList in Java."*

#### Before
> (Could trigger irrelevant transcript searches if routing was ambiguous).

#### After
> **Assistant:** In Java, both arrays and ArrayLists are used to store collections of data, but they have significant differences:
> 1. **Fixed size**: Arrays have fixed length once allocated (`int[] arr = new int[10];`).
> 2. **Resizable**: `ArrayList<Integer>` dynamically grows and shrinks as elements are added or removed.
> 3. **Primitives vs Objects**: Arrays can hold primitives (`int`, `char`); ArrayList only holds reference objects.
>
> *(Sources section: None. Clean answer without transcript tools or hallucinated citations).*

---

### Example 3: Unsupported Corpus Question
**Question:** *"What did Lenny say about quantum entanglement in superconducting circuits?"*

#### Before
> (Could hallucinate related-sounding advice or fabricate citations from an unrelated guest).

#### After
> **Assistant:** Retrieved search_transcript information was unable to return a direct match for the stated question. Lenny's Podcast focuses on product management, growth, and company building rather than quantum physics.
>
> *(Grounding tag: "No supporting evidence found in the transcripts". Citations: Suppressed).*

---

## 6. Test Commands & Actual Results

### Test Suite Summary
All unit, integration, and end-to-end tests across the entire repository pass with zero errors:

| Test Suite | Command | Total Tests | Passed | Failed |
| :--- | :--- | :---: | :---: | :---: |
| **Backend Pytest** | `python -m pytest tests -v` | 170 | 170 | 0 |
| **Agent Service Unit & Regression** | `npm test -w agent-service` | 106 | 106 | 0 |
| **Frontend Vitest** | `npm test -w frontend` | 43 | 43 | 0 |
| **TypeScript Typecheck** | `npm run typecheck` | All files | Clean | 0 |
| **Frontend Production Build** | `npm run build:frontend` | 282 modules | Built (0.26s) | 0 |
| **Grand Total** | | **319** | **319** | **0** |

### Verification of the 10 Specific Regression Scenarios

1. **Transcript-specific question with 1 correct citation**: Verified live via `cb356caf-519a-40b3-88ef-720d3c6fb955` (`Jason Cohen pricing` -> 1 citation with speaker, timestamp `00:49:05`, and inline `[1]`).
2. **Answer supported by multiple transcripts**: Verified in `MessageBubble.test.tsx` (`Both pricing [1] and distribution [2] are critical`) and `events.test.ts`.
3. **General question without irrelevant citations**: Verified live via `test_e2e_general.py` (`Java array vs ArrayList` -> routed to `general`, 0 citations, 0 grounding tags).
4. **Unsupported question with no fabricated sources**: Verified live via `test_e2e_unsupported.py` (`quantum entanglement` -> `grounded=false`, max_score 0.48, 0 citations emitted).
5. **Missing speaker and timestamp metadata**: Verified in `MessageBubble.test.tsx` line 133 (`handles missing speaker and timestamp cleanly without crashing or fabricating info`).
6. **Citation markers matching correct source cards**: Verified in `MessageBubble.test.tsx` line 92 (`renders inline citation markers [1] as interactive buttons matching source cards`). Clicking `[1]` scrolls and applies `.is-highlighted`.
7. **Incremental streaming response**: Verified in `test_e2e_chat.py` via SSE line reader; text deltas stream smoothly while citation cards linkify stably.
8. **Session isolation**: Verified in `response-quality.test.ts` Scenario 9 and `test_sessions_persistence.py` (sources from one session cannot leak into another).
9. **Malicious HTML in excerpt**: Verified in `MessageBubble.test.tsx` line 157 (`<script>alert('pwned')</script>` rendered strictly as text; zero script elements in DOM).
10. **Existing chat, retrieval, and grounding functional**: Verified with all 170 backend tests and 106 agent service tests passing.

---

## 7. Known Limitations & Technical Notes

1. **Small LLM Inline Formatting Variety**:
   With smaller local models (e.g. `llama3.2:3b`), the model may occasionally place citations as `[1]` at the end of a paragraph rather than after each individual sentence. The frontend regex supports standalone `[1]`, comma-separated `[1, 2]`, and consecutive `[1][2]` markers.
2. **Missing Source URLs**:
   Some historical podcast transcripts in the database do not contain an external URL (`t.source_url = None`). When `source_url` is missing, the frontend displays the episode title as clean text without generating a broken link.
3. **Timestamp Granularity**:
   Timestamps reflect chunk start offsets in the episode audio/video (`start_timestamp`). If a chunk spans 2 minutes of discussion, the timestamp pinpoints the beginning of that passage.
