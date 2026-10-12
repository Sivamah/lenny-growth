export interface SessionSummary {
  id: string;
  title: string | null;
  user_label: string | null;
  created_at: string;
  updated_at: string;
}

/** A transcript citation returned by the backend (agent `search_transcripts`). */
export interface Citation {
  guest: string | null;
  episode: string | null;
  timestamp: string | null;
  url: string | null;
  snippet: string | null;
  score: number | null;
}

export interface Grounding {
  grounded: boolean;
  max_score: number | null;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { input: number; output: number; total: number };
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider: string | null;
  skill: string | null;
  citations: Citation[];
  model: string | null;
  grounding: Grounding | null;
  token_usage: TokenUsage | null;
  created_at: string;
}

/** A message the client is rendering but may not yet be committed to the DB. */
export type ClientMessage = ChatMessage & {
  status?: "streaming" | "error" | "stopped";
};

export interface HealthStatus {
  status: "ok" | "degraded";
  app_name: string;
  version: string;
  environment: string;
  dependencies: Array<{ name: string; reachable: boolean; detail: string | null }>;
}

export interface ClientConfig {
  app_name: string;
  version: string;
  environment: string;
  chat_max_message_chars: number;
  retrieval_top_k: number;
  retrieval_min_score: number;
}

export interface ApiErrorBody {
  error: { code: number; message: string };
}

export interface ArtifactSummary {
  id: string;
  session_id: string;
  message_id: string | null;
  kind: "html" | "markdown";
  title: string | null;
  created_at: string;
}

export interface ArtifactRead extends ArtifactSummary {
  content: string;
}

// ---- SSE chat wire events (backend `POST /api/chat`) ----

export interface TurnStartData {
  model: string | null;
  provider: string | null;
}

export interface TextDeltaData {
  text: string;
}

export interface CitationsData {
  citations: Citation[];
}

export interface GroundingData {
  grounded: boolean;
  max_score: number | null;
}

export interface UsageData {
  usage: TokenUsage | null;
}

export interface ErrorData {
  message: string;
  retryable: boolean;
}

export interface TurnEndData {
  stop_reason: string;
  message_id: string | null;
  grounded: boolean | null;
  provider: string | null;
  model: string | null;
}

export interface ArtifactData {
  id: string;
  kind: "html" | "markdown";
  title: string | null;
  content?: string;
  message_id: string | null;
}

export type ChatEvent =
  | { type: "turn_start"; data: TurnStartData }
  | { type: "text_delta"; data: TextDeltaData }
  | { type: "tool_start"; data: Record<string, unknown> }
  | { type: "tool_end"; data: Record<string, unknown> }
  | { type: "citations"; data: CitationsData }
  | { type: "grounding"; data: GroundingData }
  | { type: "usage"; data: UsageData }
  | { type: "error"; data: ErrorData }
  | { type: "turn_end"; data: TurnEndData }
  | { type: "artifact"; data: ArtifactData };