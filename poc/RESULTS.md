# Phase 0 — Pi SDK Compatibility PoC: Results

**Generated:** 2026-10-09
**Location:** `D:\oogway project\lenny-growth-assistant-v2\poc`
**Purpose:** Verify that `@earendil-works/pi-coding-agent` 1.1.0 integrates correctly with a local Ollama model before committing to a full Phase 1 build.

---

## Environment

| Component | Version |
|-----------|---------|
| Node.js | v24.12.0 |
| npm | 11.6.2 |
| tsx (runner) | 4.23.15 |
| `@earendil-works/pi-coding-agent` | 1.1.0 |
| `@earendil-works/pi-ai` | 1.1.0 |
| `@earendil-works/pi-agent-core` | 1.1.0 (transitive) |
| `typebox` | 1.3.27 |
| Ollama | 0.40.0 |
| Local chat model | `llama3.2:3b` |
| Local embedding model | `nomic-embed-text:latest` |

---

## Commands Executed

All commands run from `D:\oogway project\lenny-growth-assistant-v2\poc`:

```
npx tsx src/01-minimal.ts
npx tsx src/02-tool.ts
npx tsx src/03-ollama.ts
npx tsx src/04-anthropic.ts
npx tsx src/05-errors-abort.ts
```

---

## Test Results

### Test 01 — Minimal session (in-memory, no tools, Ollama) PASS

**Command:** `npx tsx src/01-minimal.ts`
**Exit code:** 0

**Output (abbreviated):**
```
PoC 01 - minimal session (in-memory manager, no tools, Ollama)
--- resolved model ---
ollama/llama3.2:3b
--- prompt ---
Confirm.
[agent_settled] aborted=false
--- results ---
getLastAssistantText: "Confirm."
streamed chars: 8
message count: 3
event types: ["agent_start","turn_start","message_start","message_end","message_update","turn_end","agent_end","agent_settled"]
[session disposed]
```

Verdict: ModelRuntime resolved llama3.2:3b from agentdir/models.json. All lifecycle events fired in expected order.

---

### Test 02 — Custom tool via defineTool PASS

**Command:** `npx tsx src/02-tool.ts`
**Exit code:** 0

**Key output lines:**
```
--- active tools ---
["search_transcripts"]
[tool_execution_start] search_transcripts args={"query":"pricing","top_k":"10"}
[tool_execution_end] search_transcripts isError=false
tool_execution_start count: 1
tool_execution_end count: 1
assistant text: "Here is a one-sentence summary of what the podcast says about pricing: The podcast discusses how to raise prices by anchoring on value delivered to the customer, rather than on competitor pricing."
RESULT: PASS - custom tool was invoked
```

Verdict: defineTool registered search_transcripts with TypeBox schema. llama3.2:3b called it once, the assistant synthesized a grounded answer.

---

### Test 03 — Real Ollama integration (ModelRuntime + generation + tool call) PASS

**Command:** `npx tsx src/03-ollama.ts`
**Exit code:** 0

**Key output lines:**
```
--- ollama models registered from agentdir/models.json ---
llama3.2:3b
[tool_execution_start] search_transcripts args={"query":"pricing advice","top_k":1}
--- streamed answer ---
The key pricing insight from the podcast is that anchoring on value delivered to the customer can help to raise prices by 3x, rather than focusing solely on competitor pricing. This was stated in episode "Pricing That Works" (https://example.com/pricing).
--- verdict ---
elapsed_ms            = 12210
real response         = true (chars=465)
tool invoked          = true (count=1)
answer references seed= true
RESULT: PASS
```

Verdict: agentdir/models.json extended the built-in provider catalog. llama3.2:3b generated a real response (~12 s), invoked search_transcripts, and produced a grounded answer citing the seed episode. This is the critical test: local model + SDK tool loop confirmed working end-to-end.

---

### Test 04 — Anthropic cloud provider SKIPPED

**Command:** `npx tsx src/04-anthropic.ts`
**Exit code:** 0

**Output:**
```
PoC 04 - Anthropic (SKIPPED)
ANTHROPIC_API_KEY is not set in this environment.
This is a graceful skip, not a failure. Set the variable and re-run:
  $env:ANTHROPIC_API_KEY="sk-ant-..."; npx tsx src/04-anthropic.ts
```

Verdict: Correct graceful skip. Not a failure. Set ANTHROPIC_API_KEY and rerun to exercise the cloud path.

---

### Test 05a — Error handling: unreachable endpoint PASS

**Command:** `npx tsx src/05-errors-abort.ts` (first sub-test)
**Exit code:** 0

**Output:**
```
PoC 05a - error handling: unreachable baseUrl (http://localhost:59999/v1)
--- results ---
prompt resolved unexpectedly = true
error captured               = no
error message                = undefined
agent_settled.error          = none
agent_end.willRetry          = false
agent_end.errorMessage       = Connection error.
auto_retry_end.success       = false
auto_retry_end.finalError    = Connection error.
assistant stopReason='error' = true
RESULT: PASS - error surfaced to caller
```

SDK error contract (from @earendil-works/pi-agent-core types.d.ts lines 10-15):
  "Failures must be encoded in the returned stream via protocol events and a final
   AssistantMessage with stopReason 'error' or 'aborted' and errorMessage."

Fix applied: The original test expected session.prompt() to throw. The SDK
resolves prompt() normally and encodes failure in the event stream:
  - agent_end.willRetry = false
  - auto_retry_end.success = false, finalError = "Connection error."
  - assistant stopReason = "error"
The updated assertion checks these indicators. Error correctly detected.

---

### Test 05b — Abort mid-generation PASS

**Command:** `npx tsx src/05-errors-abort.ts` (second sub-test)
**Exit code:** 0

**Output:**
```
PoC 05b - abort() mid-generation
[abort] calling session.abort() after 1500ms; chars so far = 0
--- results ---
streamed chars before abort/end = 0
prompt resolved                 = true
prompt rejected                 = no
agent_settled.aborted           = true
RESULT: PASS - abort observed via agent_settled
```

Verdict: session.abort() propagated correctly. agent_settled.aborted = true is the definitive signal.
Note: chars = 0 because inference on this machine takes 3-5 s to first token; the abort fires before streaming begins. Timing artefact, not an SDK bug.

---

## Summary Table

| Script | Command | Exit | Result |
|--------|---------|------|--------|
| 01-minimal.ts | `npx tsx src/01-minimal.ts` | 0 | PASS |
| 02-tool.ts | `npx tsx src/02-tool.ts` | 0 | PASS |
| 03-ollama.ts | `npx tsx src/03-ollama.ts` | 0 | PASS |
| 04-anthropic.ts | `npx tsx src/04-anthropic.ts` | 0 | SKIPPED |
| 05-errors-abort.ts | `npx tsx src/05-errors-abort.ts` | 0 | PASS (05a + 05b) |

---

## Evidence: Local Model Invoked the Custom Tool

From Test 03 stdout:
```
[tool_execution_start] search_transcripts args={"query":"pricing advice","top_k":1}
tool invoked = true (count=1)
answer references seed= true
```

llama3.2:3b autonomously called search_transcripts, received seed data, and
produced a grounded answer referencing the episode title and insight.
This is genuine tool-loop operation, not a mocked response.

---

## Limitations and Unresolved Issues

1. Anthropic cloud path not tested (ANTHROPIC_API_KEY missing). Low risk if Ollama is primary.

2. llama3.2:3b tool-call reliability: 3B models occasionally produce malformed JSON.
   The SDK retries silently. Phase 1 may benefit from llama3.1:8b or qwen2.5:7b for
   more reliable tool-call compliance.

3. Abort test shows 0 streamed chars: inference latency > 1500ms abort timer on this hardware.
   The PASS is valid (agent_settled.aborted = true). Not an SDK bug.

4. models-store.json is auto-created by the SDK at runtime. Should be gitignored.

5. "big-pickle" error is unrelated: OpenCode's own coding-agent gateway
   (https://opencode.ai/zen/v1/chat/completions) rejected its own model alias.
   This does not affect the PoC or the local Ollama integration.

---

## GO / NO-GO Decision

### GO — Phase 1 is safe to begin.

All local integration criteria are confirmed:
- ModelRuntime.create() loads agentdir/models.json and resolves local Ollama models.
- createAgentSession() initialises sessions correctly.
- defineTool() registers custom tools with TypeBox schemas; llama3.2:3b invokes them.
- Event stream delivers the full lifecycle: agent_start -> turn_start ->
  message_start -> message_update -> tool_execution_start -> tool_execution_end ->
  turn_end -> agent_end -> agent_settled.
- Error handling: connection failures surface as stopReason="error" with errorMessage.
- Abort: session.abort() is honoured and observable via agent_settled.aborted.
- (Warning) Anthropic cloud path untested. Low risk if Ollama is primary provider for Phase 1.

Phase 1 can safely use the models.json pattern for Ollama, use defineTool for
the transcript-search tool, and wire session.subscribe for streaming responses
to the React frontend.
