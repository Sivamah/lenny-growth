import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the agent-service package root (one level above src/). */
export const SERVICE_ROOT = resolve(here, "..");

dotenv.config({ path: join(SERVICE_ROOT, ".env") });

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface OllamaConfig {
  /** Native root, e.g. http://localhost:11434 (no /v1). Used for /api/tags health checks. */
  nativeBaseUrl: string;
  /** OpenAI-compatible base written into models.json, e.g. http://localhost:11434/v1. */
  openAiBaseUrl: string;
  model: string;
}

export interface AnthropicConfig {
  /** True when ANTHROPIC_API_KEY is present. Optional; never required to boot. */
  enabled: boolean;
  apiKey?: string;
  model: string;
}

export interface RetrievalConfig {
  /** FastAPI internal retrieval endpoint the search_transcripts tool calls. */
  url: string;
  topK: number;
  /** When true, the tool returns a clearly-labelled stub instead of calling FastAPI. */
  mock: boolean;
  internalToken?: string;
  timeoutMs: number;
  minScore: number;
}

export interface AgentConfig {
  host: string;
  port: number;
  /** Directory where models.json / auth.json are generated for the Pi ModelRuntime. */
  agentDir: string;
  /** Working directory handed to the Pi session (resource discovery root). */
  cwd: string;
  /** Shared secret required on /v1/* when set. */
  internalToken?: string;
  ollama: OllamaConfig;
  anthropic: AnthropicConfig;
  retrieval: RetrievalConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const nativeBaseUrl = stripTrailingSlash(
    env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434",
  ).replace(/\/v1$/, "");

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const internalToken = env.INTERNAL_TOKEN?.trim() || undefined;
  // 0.60 mirrors the FastAPI RETRIEVAL_MIN_SCORE calibration (in-corpus >= 0.631,
  // out-of-corpus <= 0.557 on nomic-embed-text over the live corpus, 2026-10).
  const minScore = Number.parseFloat(env.RETRIEVAL_MIN_SCORE ?? "0.60");

  return {
    host: env.AGENT_HOST?.trim() || "127.0.0.1",
    port: readInt(env.AGENT_PORT, 8001),
    agentDir: resolve(env.AGENT_DIR?.trim() || join(SERVICE_ROOT, "agentdir")),
    cwd: resolve(env.AGENT_CWD?.trim() || SERVICE_ROOT),
    internalToken,
    ollama: {
      nativeBaseUrl,
      openAiBaseUrl: `${nativeBaseUrl}/v1`,
      model: env.OLLAMA_MODEL?.trim() || "llama3.2:3b",
    },
    anthropic: {
      enabled: Boolean(anthropicKey),
      apiKey: anthropicKey,
      model: env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5-20250929",
    },
    retrieval: {
      url: env.RETRIEVAL_URL?.trim() || "http://localhost:8000/internal/retrieve",
      topK: readInt(env.RETRIEVAL_TOP_K, 5),
      mock: readBool(env.RETRIEVAL_MOCK, false),
      internalToken,
      timeoutMs: readInt(env.RETRIEVAL_TIMEOUT_MS, 15000),
      minScore: Number.isFinite(minScore) ? minScore : 0.6,
    },
  };
}
