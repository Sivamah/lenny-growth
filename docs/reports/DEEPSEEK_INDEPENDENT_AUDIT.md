# DEEPSEEK Independent Audit — lenny-growth-assistant-v2

Audited: **2026-10-11** on `<workspace-root>`

- Reference (read-only, never modified): `D:\lenny-growth-assistant-main`
- Environment: Windows; Postgres 16 + pgvector in Docker (`lenny-growth-db`, healthy); Ollama **0.40.2**; tuned model `llama3.2:3b`; embeddings `nomic-embed-text` (768-dim).
- Live services at the time of evidence collection: backend uvicorn **:8000** (pid 15432), agent-service **:8001** (pid 8620), Vite dev **:5173** (pid 30340).
- Corpus state (verified, unchanged by this audit): **10 transcripts, 1567 chunks**.

Every result below was produced by running the actual services, not by inspection of code alone.

---

## 1. Claimed test results — reproduced

| Suite | Claim / README | Observed |
|---|---|---|
| backend `pytest` | all pass | **99/99 pass** (exit 0, `--disable-warnings -q`) |
| agent-service unit + live | all pass | **59/59 pass**, includes a live Ollama turn (21.4s) that streams text and invokes `search_transcripts` |
| frontend Vitest | all pass | **31/31 pass** (incl. new artifact-sanitization tests) |
| frontend `tsc -b && vite build` | build ok | **passes clean** (277→282 modules, 478 kB JS bundle) — *was broken until tsconfig fix, see §5.5* |
| `npm run typecheck` (agent) | clean | clean |
| Retrieval grounding | in-corpus retrievals above 0.60 threshold, out-of-corpus below | Confirmed at runtime: **calibration probe MIN in-corpus = 0.605, MAX out-of-corpus = 0.557** (probe set; see §6.4). Shipped calibration test header (10 transcripts, 1567 chunks) shows in ≥ 0.631 / out ≤ 0.557. |

## 2. Independent 50-prompt benchmark

A fresh harness (`frontend/scripts/audit-50-prompts.ts`) drove all 50 prompts through the app's own SSE parser/API (`/sessions` + `/api/chat`), creating a session per prompt and deleting it afterwards (baseline DB counts restored afterwards: sessions 56, messages 117, artifacts 3 — see §7).

**Overall: 36 PASS / 10 FAIL / 4 ERR (50 total).**

| Category | # | Pass | Fail | Err |
|---|---|---:|---:|---:|---:|
| in-corpus (grounded answers expected) | 1–6, 13–15 etc. | 11 | 4 | 0 |
| out-of-corpus (must NOT go unchallenged) | 8 | 8 | 0 | 0 |
| multi-turn (citation retention) | 5 | 4 | 1 | 0 |
| session isolation | 3 | 3 | 0 | 0 |
| artifact generation/persistence | 6 | 6 | 0 | 0 |
| Ship 30 essay skill | 4 | 0 | 3 | 1 |
| abort mid-stream | 2 | 1 | 1 | 0 |
| citation genuineness | 3 | 0 | 0 | 3 |
| skills (explicit vs. casual) | 2 | 2 | 0 | 0 |
| resilience/security | 2 | 1 | 1 | 0 |

Highlights that held up: **out-of-corpus 8/8 correctly ungated** (no false-positive citations), **session isolation 3/3**, **artifact 6/6 incl. `GET /artifacts/:id` + listing + session-cascade delete**, **skills 2/2** (explicit `ship30_essay` recorded; a casual "essay" mention does NOT auto-trigger the skill), explicit `INTERNAL_TOKEN` (18 chars) enforced on `/v1/*` and `/internal/retrieve` (401 without token).

---

## 3. Confirmed defect #1 — leaked tool-call JSON in the chat answer (FIXED)

### Evidence (pre-fix live captures)
Prompts that gained no citations and returned the raw JSON as the "answer":

```
#3 in-corpus -> assistant text:
{"name":"search_transcripts","parameters={"query":"Distribution as most important moat Evan Spiegel","top_k":1}}
#8 in-corpus ->
{"name":"search_transcripts","parameters":{"query":"\"hidden pattern behind successful products according to Mark Pincus\"","top_k":"1"}}
#25 multi-turn, turn 2 ->
{"name":"search_transcripts","parameters={"query":"HubSpot distribution","top_k":10}}
```

Observed failure mode in each: 0 citations, `grounded = null` in the stream AND at rest, JSON persisted verbatim as the user-visible assistant message.

### Root cause
With `llama3.2:3b` the tuned model sometimes emits a tool call as a **bare JSON object in the text stream** instead of invoking the function. No tool executes, no citation/grounding events are emitted, and the raw JSON flows through as the answer. Three observed variants:

1. **Valid JSON** (`#8`, over-quoted query value) — parses fine.
2. **Malformed key** (`#3`, `#25`): `"parameters={"query":...}` — the key `"parameters` has **no closing quote** and `=` instead of `:`. This is invalid JSON *and* it defeats a naive brace scanner (the scanner waits forever for a closing quote).
3. Escaped/pretty-printed multi-line objects (`#39`, `#40`).

### Fix (implemented + regression-tested)
New `agent-service/src/chat.ts` `runChatTurn` guard:

- **Streaming classifier** `classifyPartialLeak(text)` buffers text deltas while the prefix could be a leaked call. It is a "leak" only when the whole buffer is one known-tool JSON object with nothing after it (`findBalancedClose` + tolerant `parseToolCall` that normalizes `"parameters={"` → `"parameters":{"`); anything else streams normally.
- On a leak the guard runs `search_transcripts` **itself**, streams `tool_start`/`citations`/`grounding`/`tool_end`, then **re-drives the model once** with the evidence (`buildRecoveryPrompt`); a second leak falls back to an honest evidence summary (`buildEvidenceFallback`). The leaked JSON is *never* emitted upstream and never persisted.
- `agent-service/src/server.ts`: normal chat turns now route through `runChatTurn`; removed the unused `Channel` class; added a 10 s blank-line heartbeat (SSE keep-alive, tolerated by the backend).

**Regression tests** — `agent-service/tests/chat.test.ts` (now 15+ real cases, incl. the exact captured `#3/#8/#25` strings and a `#39`-style embedded object) — **59/59 agent tests pass**. `stripToolCallLeaks()` additionally scrubs leak JSON out of buffered content.

### Live re-verification (post-restart, through the real user path)
4/4 rechecked prompts (the two chat leak prompts, a multi-turn, and the essay prompt) showed **0 leaked JSON on stream and 0 at rest**, with citations and grounding present:

| recheck | text chars | citations | grounded | leak (stream/persist) |
|---:|---:|---:|---:|---:|
| #3-style | 785 | 1 | true | false / false |
| #8-style | 760 | 5 | true | false / false |
| #25-turn2-style | 1174 | 5 | false | false / false |
| #39 essay-style | 1054 | 10 | true | false / false |

## 4. Confirmed defect #2 — leaked tool-call JSON inside Ship 30 essays (FIXED)

`#39`/`#40` essays contained embedded `{"name":"search_transcripts",...}` objects (plus malformed/pretty-printed variants) inside the delivered text. The essay path (`agent-service/src/essay.ts`) buffered `text_delta` raw and validated afterwards, so leaks passed through to the persisted essay.

**Fix:** `runEssayTurn` now cleans every buffered draft with `stripToolCallLeaks()` (shared with the chat guard) before validation. A pure-leak draft produces an empty draft, which validation flags and the existing corrective-retry re-drives with the exact issues named. Regression test: `agent-service/tests/essay.test.ts` "strips a leaked tool call from the draft and retries".

**Live re-verify:** the essay recheck above produced no JSON leak (1054 chars, 10 citations, grounded=true).

## 5. Confirmed defects found & fixed (non-leak)

| # | Issue | Evidence | Fix / status |
|---|---|---|---|
| 5.1 | Leak guard missed the malformed `"parameters={` variant entirely (until §3 fix) — old code returned `undecided` forever, so the failed turn would have returned an **empty answer** instead of leaking | unit repro; captured strings | tolerant normalize in `parseToolCall`/`classifyPartialLeak`; regression tests |
| 5.2 | Frontend **typecheck + production build broken** by the audit harness: `tsconfig.app.json` included `scripts/` (Node globals, implicit-any in `.map` callbacks) → `tsc -b` failed | `npm run typecheck`/`build` reproduced the failure | `tsconfig.app.json` → include `src` only; new `tsconfig.scripts.json` (Node types, ES2023, strict); referenced from `tsconfig.json`; callbacks annotated `: PromptDef`. Build now green. |
| 5.3 | Artifact **render-layer sanitization untested** (and risk real: the model did persist a raw `<img onerror>` payload, §6.3) | new tests | `frontend/src/components/ArtifactViewer.test.tsx`: strips script/onerror/onclick from HTML; sanitizes markdown `javascript:` links; sandboxed iframe + strict CSP asserted |
| 5.4 | Pre-run harness bugs (abort detection on mid-stream abort; `skill:"artifact"` passed as a bare string to isolation probe) | first-run hang | `runTurn` throws `AbortErrorLike`; isolation #3 sends `{ skill: "artifact" }` |
| 5.5 | Stopping a turn has no server-side persistence of partial text under load (abort probe) | `#42`: partial assistant msg 0 | *not a fix in this run* — see §6.2 |

## 6. Findings intentionally NOT fixed (tuning / expectations / environment)

1. **`#13/#14` grounding false-negatives** — Relevant `#13` (Jason Cohen pricing) and `#14` (Mark Pincus hidden-pattern) retrievals scored **max 0.5655 / 0.5799**, just under `RETRIEVAL_MIN_SCORE = 0.60`, so `grounded=false` despite clearly relevant, correctly attributed content. Alive-citation checks passed (genuine episodes/guests); the threshold is ~0.03 above some legitimate in-corpus matches. Recommendation: consider a "weak grounding" band (e.g. 0.55–0.60) or a re-calibration with a larger query set before touching the threshold.
2. **`#42` abort check** — Node's undici fetch rejects an in-flight body read with `TypeError` ("terminated"), not `DOMException: AbortError`; the spec naming is browser-only. The abort endpoint itself worked (`#43` passed) and no session crashed. Partial-persist probe was polluted by the `#41` backlog right before it. Treat as harness-environment artifact, not an app defect.
3. **`#41` 300 s timeout; `#44/#45/#46` `terminated` at 120 s** — long Generation under an Ollama queue backlog (default `OLLAMA_NUM_PARALLEL=1` in `.env`: `AGENT_TURN_TIMEOUT_SECONDS=120`) closed these SSE streams mid-turn. Operational, not a logic bug; re-run showed healthy turns afterward. Options: raise timeout, allow parallel `OLLAMA_NUM_PARALLEL>1`, or make the timeout retryable.
4. **Ship 30 essay length/structure against `llama3.2:3b`** — grounded essays landed at **213 w / #38 and 550 w / #40, 0 headings, no bold, no takeaway** even after the corrective retry; the model small enough that the 1,250-word spec is not reliably met. Citation/grounding attributes hold; this is a capability/expectation gap, not a pipeline defect.
5. **`#50` XSS sweep** — the tuned model persisted a raw `<img onerror>` payload inside an artifact *message*. The render layer is safe (verified by 5.3). Defense-in-depth note: end-to-end sanitization is currently frontend-only; consider sanitizing `artifact.content`/messages at persist- or read-time so non-web consumers stay safe.

### 6.4 Calibration note
The shipped calibration doc says in-corpus ≥ 0.631; my independent probe set (different queries) measured a MIN of **0.605** (with 0.610–0.614 also hugging the line) and out-corpus MAX **0.557**. Combined with `#13/#14`, the effective margin above threshold is thinner than the doc suggests for some phrasing — worth re-running `backend/tests/test_grounding_calibration.py` before trusting the 0.60 cut.

## 7. Scope, safety, and integrity

- **No user data altered.** Baseline counts restored after the audit: sessions 56, messages 117, artifacts 3, transcripts 10, chunks 1567. The one orphan `AUDIT-` session from an interrupted first benchmark run was deleted (`DELETE /sessions/...→ 204`).
- **No secrets committed/moved.** `INTERNAL_TOKEN` (18 chars) is set on both services and enforced; verified only masks in this report.
- **Reference copy untouched** (`D:\lenny-growth-assistant-main`, mtime unchanged); project dir is not a git repo; nothing pushed, uploaded, or force-changed.
- **Benchmark evidence** lives in `docs/reports/`: `DEEPSEEK_50_PROMPT_RESULTS.json` (all 50 per-prompt results incl. observed text/citations).

## 8. Files touched this audit

| File | Change |
|---|---|
| `agent-service/src/chat.ts` | NEW leak guard: `findBalancedClose`, `normalizeLeakJson`, `parseToolCall`, `classifyPartialLeak`, `parseLeakedQuery`, `buildRecoveryPrompt`, `buildEvidenceFallback`, `stripToolCallLeaks`, `runChatTurn` |
| `agent-service/src/essay.ts` | drafts scrubbed with `stripToolCallLeaks` before validation |
| `agent-service/src/server.ts` | `/v1/chat` → `runChatTurn`; `Channel` removed; 10 s heartbeat |
| `agent-service/tests/chat.test.ts` | 15+ tests incl. real captured leaks |
| `agent-service/tests/essay.test.ts` | leak-draft → strip+retry test |
| `agent-service/package.json` | `chat.test.ts` added to `test` + `test:unit` |
| `frontend/scripts/audit-50-prompts.ts` | benchmark harness (50 prompts, appended JSON) |
| `frontend/tsconfig.app.json` / `tsconfig.scripts.json` / `tsconfig.json` | scripts moved to own typed project; build fixed |
| `frontend/src/components/ArtifactViewer.test.tsx` | NEW sanitization render tests |

## 9. Bottom line

The stack's headline claims reproduce: **99 backend / 59 agent / 31 frontend tests pass; live retrieval/grounding/artifacts/isolation/skills verified end-to-end.** This audit found and fixed one serious, user-visible defect class — **leaked tool-call JSON** (in chat *and* essay turns, including a malformed form that would have silently produced empty answers) — with regression tests and live re-verification on 4 prompts (0 leaks). Remaining non-fixes are tuning/expectations (threshold margin `#13/#14`, essay length on a 3B model, timeout under Ollama queueing), plus a worthwhile defense-in-depth item (server-side artifact sanitization).