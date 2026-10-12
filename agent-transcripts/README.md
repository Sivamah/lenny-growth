# Genuine Agent Transcripts & Audit Log

This directory contains genuine transcripts and diagnostic logs with sensitive information redacted (specifically local absolute Windows user paths and environment tokens), generated during the autonomous development, debugging, testing, and hardening of **Lenny Growth Assistant V2**.

Per assignment guidelines, **zero synthetic or fabricated dialogues were created**. These transcripts were extracted directly from the local agent execution SQLite store (`opencode.db`) and IDE execution logs, with local user paths sanitized to generic placeholders.

---

## Transcript Index

| File | Phase / Area | Genuine Failed Attempts, Issues & Corrections Documented |
| :--- | :--- | :--- |
| [`01_phase0_sdk_verification_and_error_fixes.md`](file:///D:/oogway%20project/lenny-growth-assistant-v2/agent-transcripts/01_phase0_sdk_verification_and_error_fixes.md) | Phase 0 SDK Verification | **Failed Attempt:** Assertion mismatch in `05-errors-abort.ts` when `@earendil-works/pi-coding-agent` returned an abort error structure differing from unit test assumptions; gateway connection error when attempting to reach remote Big-Pickle gateway.<br>**Correction:** Calibrated abort exception matcher and re-routed all inference to local Ollama (`llama3.2:3b`). |
| [`02_phase1_architecture_implementation.md`](file:///D:/oogway%20project/lenny-growth-assistant-v2/agent-transcripts/02_phase1_architecture_implementation.md) | Phase 1 Foundation | **Implementation & Validation:** Built database models, pgvector migrations, chunking pipeline, FastAPI backend routes, agent service session pool, and React/Vite frontend. |
| [`03_qa_audit_tool_leakage_and_constraint_fixes.md`](file:///D:/oogway%20project/lenny-growth-assistant-v2/agent-transcripts/03_qa_audit_tool_leakage_and_constraint_fixes.md) | QA Audit & Regression | **Major Defect Discovered:** 50-prompt automated benchmark revealed that raw JSON tool calls (`search_transcripts(...)`) were leaking into the user text stream; citations were emitting on ungrounded questions; general questions were hallucinating podcast guest attributions.<br>**Correction:** Implemented heuristic turn routing (`routing.ts`), suppressed citation wire events when `grounded: false`, and created the constraint validation engine (`constraints.ts`). |
| [`04_artifact_sanitization_pipeline_audit.md`](file:///D:/oogway%20project/lenny-growth-assistant-v2/agent-transcripts/04_artifact_sanitization_pipeline_audit.md) | Security Hardening | **Security Audit:** Audited end-to-end artifact generation and HTML rendering pipeline to prevent XSS. Verified server-side Python Bleach tag whitelist and client-side DOMPurify + `sandbox=""` iframe isolation with strict Content Security Policy. |
| [`05_final_audit_and_submission_readiness.md`](file:///D:/oogway%20project/lenny-growth-assistant-v2/agent-transcripts/05_final_audit_and_submission_readiness.md) | Final Review & Deliverables | **Defect Discovered:** Missing `/artifacts` proxy route in `frontend/vite.config.ts`, causing 404s on artifact fetches during development; mismatched passwords in `.env.example`.<br>**Correction:** Added `/artifacts` Vite proxy, unified environment templates, cleaned obsolete scratch files, pushed to GitHub `main`, and generated project documentation. |

---

## Key Engineering Takeaways from Agent Logs

1. **Local Model Reliability**: Relying on local LLMs (`llama3.2:3b`) requires robust system instructions and dynamic tool deactivation. When retrieval tools were permanently active, the model attempted to attribute unrelated general questions (Java syntax, study habits) to podcast guests. Dynamic routing in `routing.ts` resolved this completely.
2. **Double-Layer Defense-in-Depth**: Testing showed that relying solely on client-side sandboxing or server-side escaping is insufficient for AI-generated HTML. Combining Python `bleach` sanitization on the backend with client-side `DOMPurify` and iframe `sandbox=""` with strict CSP guarantees total containment against malicious script execution.
3. **Reproducibility Over Ad-Hoc Scripts**: Moving ad-hoc test scripts into documented suites (`poc/src/`, `scripts/`) and structuring reports in `docs/reports/` ensures seamless onboarding and reproducible grading.
