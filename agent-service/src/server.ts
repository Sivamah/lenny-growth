import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig, type AgentConfig } from "./config.ts";
import { createAgentRuntime, type AgentRuntime } from "./runtime.ts";
import { SessionPool, type HistoryMessage, type LiveSession } from "./session-pool.ts";
import { type StopReason, type WireEvent } from "./events.ts";
import { runChatTurn, type ChatSession } from "./chat.ts";
import {
  buildEssayPrompt,
  runEssayTurn,
  SHIP30_ESSAY_SKILL_NAME,
} from "./essay.ts";
import { ARTIFACT_SKILL_NAME, runArtifactTurn } from "./artifact.ts";
import { SEARCH_TRANSCRIPTS_TOOL_NAME } from "./tools/search-transcripts.ts";
import { routeTurn } from "./routing.ts";

const SERVICE_NAME = "lenny-agent-service";
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface TurnRequest {
  session_id?: unknown;
  turn_id?: unknown;
  prompt?: unknown;
  skill?: unknown;
  history?: unknown;
  model?: { provider?: unknown; id?: unknown };
}

export interface AgentServerHandle {
  server: Server;
  cfg: AgentConfig;
  runtime: AgentRuntime;
  pool: SessionPool;
  url: string;
  close(): Promise<void>;
}

export async function startAgentServer(
  cfg: AgentConfig = loadConfig(),
  options: { port?: number } = {},
): Promise<AgentServerHandle> {
  const runtime = await createAgentRuntime(cfg);
  const pool = new SessionPool(cfg, runtime.runtime);

  const server = createServer((req, res) => {
    void route(req, res, { cfg, runtime, pool }).catch((error) => {
      fail(res, error);
    });
  });

  const port = options.port ?? cfg.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, cfg.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${cfg.host}:${actualPort}`;

  const close = (): Promise<void> => {
    pool.disposeAll();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, cfg, runtime, pool, url, close };
}

interface RouteContext {
  cfg: AgentConfig;
  runtime: AgentRuntime;
  pool: SessionPool;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (method === "GET" && (path === "/" || path === "/v1/health")) {
    if (path === "/" && method === "GET") {
      return json(res, 200, {
        service: SERVICE_NAME,
        version: VERSION,
        endpoints: ["GET /v1/health", "POST /v1/turn", "POST /v1/abort", "DELETE /v1/sessions/:id"],
      });
    }
    return handleHealth(res, ctx);
  }

  if (!authorized(ctx.cfg, req)) {
    return json(res, 401, { error: { code: 401, message: "Missing or invalid X-Internal-Token" } });
  }

  if (method === "POST" && path === "/v1/turn") {
    return handleTurn(req, res, ctx);
  }
  if (method === "POST" && path === "/v1/abort") {
    return handleAbort(req, res, ctx);
  }
  if (method === "DELETE" && path.startsWith("/v1/sessions/")) {
    const id = decodeURIComponent(path.slice("/v1/sessions/".length));
    if (!id) throw new HttpError(400, "session_id is required in the path");
    const removed = ctx.pool.dispose(id);
    return json(res, removed ? 200 : 404, { session_id: id, removed });
  }

  return json(res, 404, { error: { code: 404, message: `No route for ${method} ${path}` } });
}

function authorized(cfg: AgentConfig, req: IncomingMessage): boolean {
  if (!cfg.internalToken) return true;
  const provided = req.headers["x-internal-token"];
  return typeof provided === "string" && provided === cfg.internalToken;
}

async function handleHealth(res: ServerResponse, ctx: RouteContext): Promise<void> {
  const ollama = await checkOllama(ctx.cfg);
  json(res, 200, {
    status: ollama.reachable ? "ok" : "degraded",
    service: SERVICE_NAME,
    version: VERSION,
    uptime_s: Math.round(process.uptime()),
    providers: {
      ollama: {
        base_url: ctx.cfg.ollama.nativeBaseUrl,
        model: ctx.cfg.ollama.model,
        reachable: ollama.reachable,
        models: ollama.models,
        error: ollama.error,
      },
      anthropic: {
        configured: ctx.cfg.anthropic.enabled,
        model: ctx.cfg.anthropic.model,
        note: ctx.cfg.anthropic.enabled
          ? "configured (not exercised in this environment)"
          : "not configured",
      },
    },
    retrieval: {
      url: ctx.cfg.retrieval.url,
      mock: ctx.cfg.retrieval.mock,
      top_k: ctx.cfg.retrieval.topK,
    },
    live_sessions: ctx.pool.size,
    runtime: { models_path: ctx.runtime.modelsPath, auth_path: ctx.runtime.authPath },
  });
}

async function checkOllama(
  cfg: AgentConfig,
): Promise<{ reachable: boolean; models: string[]; error?: string }> {
  try {
    const response = await fetch(`${cfg.ollama.nativeBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      return { reachable: false, models: [], error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");
    return { reachable: true, models };
  } catch (error) {
    return {
      reachable: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleAbort(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as { session_id?: unknown };
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  if (!sessionId) throw new HttpError(400, "session_id is required");
  const aborted = await ctx.pool.abort(sessionId);
  json(res, aborted ? 200 : 404, { session_id: sessionId, aborted });
}

async function handleTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as TurnRequest;
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!sessionId) throw new HttpError(400, "session_id is required");
  if (!prompt) throw new HttpError(400, "prompt is required");

  const selection = readModelSelection(body.model);
  const history = readHistory(body.history);
  const live = await ctx.pool.ensure(sessionId, selection, history);

  const skill = readSkill(body.skill);
  if (skill === SHIP30_ESSAY_SKILL_NAME) {
    (live.session as any).setActiveToolsByName?.([SEARCH_TRANSCRIPTS_TOOL_NAME]);
    await handleEssayTurn(req, res, live, prompt);
    return;
  }
  if (skill === ARTIFACT_SKILL_NAME) {
    (live.session as any).setActiveToolsByName?.([]);
    await handleArtifactTurn(req, res, live, prompt);
    return;
  }

  // Determine conversation route:
  const decision = routeTurn(prompt, history);
  console.log(
    JSON.stringify({
      level: "info",
      msg: "turn_routed",
      session_id: sessionId,
      route: decision.route,
      reason: decision.reason,
      prompt_prefix: prompt.slice(0, 80),
    }),
  );

  if (decision.route === "transcript") {
    (live.session as any).setActiveToolsByName?.([SEARCH_TRANSCRIPTS_TOOL_NAME]);
  } else {
    // "general" or "follow_up": deactivate search_transcripts tool
    (live.session as any).setActiveToolsByName?.([]);
  }

  await handleChatTurn(req, res, ctx, live, prompt);
}

/**
 * Normal chat turns run through a leaked-tool-call guard: if the model emits a
 * bare JSON tool call as its final text instead of a real answer, the JSON is
 * never shown, the tool is executed for evidence, and a single corrective pass
 * recovers a grounded answer.
 */
async function handleChatTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  live: LiveSession,
  prompt: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeLine(res, { type: "turn_start", model: live.modelLabel });

  let finished = false;
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write("\n");
  }, 10000);

  req.on("close", () => {
    if (!finished) void live.session.abort().catch(() => undefined);
  });

  try {
    const result = await runChatTurn(
      ctx.cfg,
      live.session as unknown as ChatSession,
      prompt,
      (wire) => {
        if (!res.writableEnded) writeLine(res, wire);
      },
    );

    if (!res.writableEnded) {
      const stop: StopReason = result.aborted
        ? "aborted"
        : result.errorMessage
          ? "error"
          : "stop";
      if (stop === "error") {
        writeLine(res, {
          type: "error",
          message: result.errorMessage ?? "Agent error",
          retryable: true,
        });
      }
      writeLine(res, { type: "turn_end", stop_reason: stop });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

/**
 * Ship 30 essay turns run through the buffered essay pipeline. Assistant text
 * is held until the final pass (so a corrective retry supersedes the failed
 * draft), while non-text events (tool calls, citations, grounding, usage) stream
 * live. The reviewed essay is emitted as a single text_delta before turn_end.
 */
async function handleEssayTurn(
  req: IncomingMessage,
  res: ServerResponse,
  live: LiveSession,
  prompt: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeLine(res, { type: "turn_start", model: live.modelLabel });

  let finished = false;
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write("\n");
  }, 10000);

  req.on("close", () => {
    if (!finished) void live.session.abort().catch(() => undefined);
  });

  try {
    const result = await runEssayTurn(live.session, prompt, (wire) => {
      if (!res.writableEnded) writeLine(res, wire);
    });

    if (!res.writableEnded) {
      if (result.text) {
        writeLine(res, { type: "text_delta", text: result.text });
      }
      const stop: StopReason = result.aborted
        ? "aborted"
        : result.errorMessage
          ? "error"
          : "stop";
      if (stop === "error") {
        writeLine(res, {
          type: "error",
          message: result.errorMessage ?? "Agent error",
          retryable: true,
        });
      }
      writeLine(res, { type: "turn_end", stop_reason: stop });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

async function handleArtifactTurn(
  req: IncomingMessage,
  res: ServerResponse,
  live: LiveSession,
  prompt: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeLine(res, { type: "turn_start", model: live.modelLabel });

  let finished = false;
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write("\n");
  }, 10000);

  req.on("close", () => {
    if (!finished) void live.session.abort().catch(() => undefined);
  });

  try {
    const result = await runArtifactTurn(live.session as any, prompt, (wire) => {
      if (!res.writableEnded) writeLine(res, wire);
    });

    if (!res.writableEnded) {
      if (result.explanation || !result.content) {
        writeLine(res, { type: "text_delta", text: result.explanation || "Failed to generate artifact." });
      }
      if (result.content && !result.errorMessage) {
        writeLine(res, { type: "artifact", kind: result.kind, content: result.content, title: result.title });
      }
      const stop: StopReason = result.aborted
        ? "aborted"
        : result.errorMessage
          ? "error"
          : "stop";
      if (stop === "error") {
        writeLine(res, {
          type: "error",
          message: result.errorMessage ?? "Agent error",
          retryable: true,
        });
      }
      writeLine(res, { type: "turn_end", stop_reason: stop });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

function readModelSelection(raw: TurnRequest["model"]): { provider?: string; id?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const provider = typeof raw.provider === "string" ? raw.provider : undefined;
  const id = typeof raw.id === "string" ? raw.id : undefined;
  return provider && id ? { provider, id } : undefined;
}

function readSkill(raw: TurnRequest["skill"]): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

const MAX_REPLAYED_HISTORY = 80;

/** Validate the distilled {role, content} history frames FastAPI replays. */
function readHistory(raw: TurnRequest["history"]): HistoryMessage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const selected: HistoryMessage[] = [];
  for (const frame of raw.slice(-MAX_REPLAYED_HISTORY)) {
    if (!frame || typeof frame !== "object") continue;
    const record = frame as { role?: unknown; content?: unknown };
    if (typeof record.content !== "string" || record.content.trim().length === 0) continue;
    if (record.role !== "user" && record.role !== "assistant") continue;
    selected.push({ role: record.role, content: record.content });
  }
  return selected.length > 0 ? selected : undefined;
}

function writeLine(res: ServerResponse, event: WireEvent | { type: "turn_start"; model: string }): void {
  res.write(`${JSON.stringify(event)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "Request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON body");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  json(res, status, { error: { code: status, message } });
}

async function main(): Promise<void> {
  const handle = await startAgentServer();
  console.log(
    JSON.stringify({
      level: "info",
      msg: "agent-service listening",
      url: handle.url,
      model: handle.cfg.ollama.model,
      retrieval_mock: handle.cfg.retrieval.mock,
    }),
  );

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ level: "error", msg: "fatal", error: String(error) }));
    process.exit(1);
  });
}
