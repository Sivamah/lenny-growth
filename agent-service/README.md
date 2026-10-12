# agent-service

Node.js / TypeScript service that wraps the **Pi Coding Agent SDK**
(`@earendil-works/pi-coding-agent@1.1.0`) and exposes the Lenny Growth Assistant
agent over HTTP. It runs locally against Ollama and calls the FastAPI backend's
internal retrieval endpoint for transcript evidence. The React frontend and
artifact/skill features are separate later phases.

## What it does

- Boots a Pi `ModelRuntime` from a generated `agentdir/models.json` (Ollama as an
  OpenAI-compatible provider). No model network access at startup.
- Maintains an in-process pool of Pi sessions keyed by `session_id`.
- Registers a single custom tool, `search_transcripts`, which calls the FastAPI
  internal retrieval endpoint (or a clearly-labelled mock when FastAPI is absent).
- Streams each turn as **NDJSON** over `POST /v1/turn`.

## Requirements

- Node.js >= 22.19 (verified on v24.12.0)
- Ollama running locally with the configured model pulled (default `llama3.2:3b`)

## Setup & run

```powershell
npm install
npm run typecheck
npm start            # listens on http://127.0.0.1:8001
npm run smoke        # starts an ephemeral server, runs a real turn, prints NDJSON
npm test             # unit + real-Ollama integration test (Ollama test skips if absent)
```

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_HOST` | `127.0.0.1` | Bind address |
| `AGENT_PORT` | `8001` | Bind port |
| `AGENT_DIR` | `<service>/agentdir` | Where `models.json` / `auth.json` are generated |
| `AGENT_CWD` | service root | Working dir / resource-discovery root for sessions |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Native Ollama root (`/v1` is added automatically) |
| `OLLAMA_MODEL` | `llama3.2:3b` | Model id written into the catalogue |
| `ANTHROPIC_API_KEY` | _(unset)_ | Optional; enables the Anthropic provider via `setRuntimeApiKey` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | Model id reported for Anthropic |
| `RETRIEVAL_URL` | `http://localhost:8000/internal/retrieve` | FastAPI retrieval endpoint |
| `RETRIEVAL_TOP_K` | `5` | Default result count for `search_transcripts` |
| `RETRIEVAL_MOCK` | `false` | When true, `search_transcripts` returns a stub, never calls FastAPI |
| `RETRIEVAL_MIN_SCORE` | `0.60` | Threshold used to compute `grounded` if FastAPI omits it |
| `RETRIEVAL_TIMEOUT_MS` | `15000` | Retrieval request timeout |
| `INTERNAL_TOKEN` | _(unset)_ | If set, `/v1/*` requires header `X-Internal-Token`; also sent to retrieval |

> **Retrieval modes.** With `RETRIEVAL_MOCK=true` the tool returns
> `source: "mock"` and content prefixed `[MOCK RETRIEVAL - NOT REAL TRANSCRIPTS]`.
> Otherwise it calls `RETRIEVAL_URL` and returns `source: "fastapi"`. The two are
> always distinguishable in tool details so callers never mistake mock for real data.

## HTTP API

### `GET /v1/health`

Always returns `200`. `status` is `ok` when Ollama is reachable, else `degraded`.
Reports provider reachability/model list, retrieval config, live session count, and
the generated runtime paths.

### `POST /v1/turn` → `200 application/x-ndjson`

Request body:

```json
{ "session_id": "string (required)", "prompt": "string (required)",
  "turn_id": "optional", "skill": "optional",
  "model": { "provider": "ollama", "id": "llama3.2:3b" }, "history": [] }
```

> `history` (`{ role: "user" | "assistant", content }[]`) is replayed into a
> freshly created in-memory session via `SessionManager.appendMessage`, so a new
> Node process (or a disposed session) can answer follow-ups that reference prior
> turns. The same `session_id` reuses the live session, which already holds the
> conversation. Existing sessions ignore `history`.

NDJSON events, one JSON object per line:

| `type` | Fields |
| --- | --- |
| `turn_start` | `model` |
| `text_delta` | `text` |
| `tool_start` | `name`, `args` |
| `tool_end` | `name`, `isError`, `durationMs` |
| `citations` | `citations[]` (`guest`, `episode`, `timestamp`, `url`, `snippet`, `score`) |
| `grounding` | `grounded`, `maxScore` |
| `usage` | `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `cost`) |
| `error` | `message`, `retryable` |
| `turn_end` | `stop_reason`: `stop` \| `error` \| `aborted` |

### `POST /v1/abort`

Body `{ "session_id": "..." }` → aborts the live turn. Returns `{ aborted: true|false }`.

### `DELETE /v1/sessions/:id`

Disposes the pooled session. Returns `{ removed: true|false }`.

## Tool: `search_transcripts`

Parameters: `query` (string), `top_k` (number, optional; clamped 1–20).

Result `details`:

```json
{ "query": "...", "source": "fastapi|mock", "grounded": true,
  "max_score": 0.81, "returned": 3, "error": "optional on failure" }
```

The same payload is returned to the model as JSON text content. On retrieval
failure the tool returns `isError: true` so the agent can react.

## Layout

```
agent-service/
  agentdir/                 models.example.json, auth.example.json (generated files are gitignored)
  src/config.ts             env -> AgentConfig
  src/runtime.ts            models.json generation + ModelRuntime
  src/events.ts             SDK event -> wire event mapping, citation extraction
  src/retrieval.ts          FastAPI retrieval client + mock stub
  src/tools/search-transcripts.ts
  src/session-pool.ts       in-process session pool
  src/server.ts             HTTP server (health / turn / abort / sessions)
  scripts/smoke-turn.ts     end-to-end NDJSON smoke test
  scripts/check.ts          config / model / Ollama diagnostic
  tests/                    events, tool, and real-Ollama tests
```

## Connecting to the FastAPI retrieval endpoint

The FastAPI backend now implements `POST /internal/retrieve` (embed query →
pgvector similarity → citable chunks). To point the agent at it:

```powershell
$env:RETRIEVAL_URL = "http://127.0.0.1:8000/internal/retrieve"
$env:INTERNAL_TOKEN = "<same value as the backend's INTERNAL_TOKEN>"   # if set
$env:RETRIEVAL_MOCK = "false"   # default; real retrieval
npm start
```

Both services must share the same `INTERNAL_TOKEN` (or both leave it unset for
local dev). Set `RETRIEVAL_MOCK=true` only to run the agent without a backend;
in that mode results are marked `source: "mock"` and prefixed
`[MOCK RETRIEVAL - NOT REAL TRANSCRIPTS]`, and must never be treated as real
transcript evidence.

## Scope & limitations

- In-memory sessions; history is replayed from FastAPI/Postgres on first use, so a
  restart or disposed session rehydrates the conversation. Live replay latency
  depends on the model's context size.
- Anthropic provider path is wired but **not exercised** here (no API key in this env).
- Real retrieval requires the FastAPI backend, PostgreSQL + pgvector, and an
  ingested corpus. Without them, use `RETRIEVAL_MOCK=true`.
- No auth beyond the optional `INTERNAL_TOKEN` shared secret.
