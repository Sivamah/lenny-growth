import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export const SEARCH_TOOL_NAME = "search_transcripts";

export interface Citation {
  index?: number;
  chunk_id?: string;
  speaker?: string;
  guest?: string;
  episode?: string;
  timestamp?: string;
  url?: string;
  snippet?: string;
  score?: number;
}

export type StopReason = "stop" | "error" | "aborted";

/** Compact, provider-agnostic view of a turn's token accounting. */
export interface TokenUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { input?: number; output?: number; total?: number } | null;
}

/**
 * Wire events emitted over the /v1/turn NDJSON stream.
 * These are intentionally decoupled from the SDK's event shapes.
 */
export type WireEvent =
  | { type: "turn_start"; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; isError: boolean; durationMs?: number }
  | { type: "citations"; citations: Citation[] }
  | { type: "grounding"; grounded: boolean; maxScore?: number }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "turn_end"; stop_reason: StopReason }
  | { type: "artifact"; kind: "html" | "markdown"; content: string; title?: string };

interface RetrievalChunkLike {
  chunk_id?: unknown;
  speaker?: unknown;
  start_speaker?: unknown;
  guest?: unknown;
  episode_title?: unknown;
  episode?: unknown;
  timestamp?: unknown;
  start_timestamp?: unknown;
  source_url?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
}

interface RetrievalPayloadLike {
  results?: unknown;
  grounded?: unknown;
  max_score?: unknown;
}

/** Parse the JSON text block the tool embeds in `content` (holds the results array). */
function parseContentPayload(content: unknown): RetrievalPayloadLike | undefined {
  if (!Array.isArray(content)) return undefined;
  const textBlock = content.find(
    (block): block is { type: string; text: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  if (!textBlock) return undefined;
  try {
    return JSON.parse(textBlock.text) as RetrievalPayloadLike;
  } catch {
    return undefined;
  }
}

/**
 * Merge the tool result's `content` text block (carries `results`) with its
 * `details` object (carries `grounded`/`max_score`). `details` wins on shared
 * keys, but `results` survives when `details` omits it.
 */
function unwrapToolPayload(result: unknown): RetrievalPayloadLike | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as { details?: unknown; content?: unknown };
  const fromContent = parseContentPayload(record.content);
  const fromDetails =
    record.details && typeof record.details === "object"
      ? (record.details as RetrievalPayloadLike)
      : undefined;
  const merged = { ...(fromContent ?? {}), ...(fromDetails ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extract the grounding decision a search_transcripts tool reported, if any. */
export function extractGroundingFromResult(result: unknown): { grounded: boolean; maxScore?: number } | undefined {
  const payload = unwrapToolPayload(result);
  if (!payload) return undefined;
  const record = payload as { grounded?: unknown; max_score?: unknown };
  if (typeof record.grounded !== "boolean") return undefined;
  const maxScore = typeof record.max_score === "number" ? record.max_score : undefined;
  return maxScore === undefined ? { grounded: record.grounded } : { grounded: record.grounded, maxScore };
}

/** Convert a search_transcripts tool result into a compact citation list. */
export function extractCitationsFromResult(result: unknown): Citation[] {
  const payload = unwrapToolPayload(result);
  const rawResults = payload?.results;
  if (!Array.isArray(rawResults)) return [];
  return rawResults
    .map((raw, idx): Citation => {
      const chunk = (raw ?? {}) as RetrievalChunkLike;
      const content = asString(chunk.content);
      const speaker =
        asString(chunk.speaker) ??
        asString(chunk.start_speaker) ??
        asString(chunk.guest);
      return {
        index: idx + 1,
        chunk_id: asString(chunk.chunk_id),
        speaker,
        guest: asString(chunk.guest),
        episode: asString(chunk.episode_title) ?? asString(chunk.episode),
        timestamp: asString(chunk.timestamp) ?? asString(chunk.start_timestamp),
        url: asString(chunk.source_url) ?? asString(chunk.url),
        snippet: content ? content.slice(0, 320) : undefined,
        score: typeof chunk.score === "number" ? chunk.score : undefined,
      };
    })
    .filter((citation) => Boolean(citation.guest || citation.episode || citation.url));
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Normalise a provider usage blob into the compact TokenUsage shape. */
export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const input = asNumber(record.input);
  const output = asNumber(record.output);
  const totalTokens = asNumber(record.totalTokens);
  if (input === undefined && output === undefined && totalTokens === undefined) return undefined;
  const costRecord =
    record.cost && typeof record.cost === "object" && !Array.isArray(record.cost)
      ? (record.cost as Record<string, unknown>)
      : undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    totalTokens: totalTokens ?? (input ?? 0) + (output ?? 0),
    cacheRead: asNumber(record.cacheRead),
    cacheWrite: asNumber(record.cacheWrite),
    reasoning: asNumber(record.reasoning),
    cost: costRecord
      ? {
          input: asNumber(costRecord.input),
          output: asNumber(costRecord.output),
          total: asNumber(costRecord.total),
        }
      : null,
  };
}

/** Extract the first assistant-message usage blob from an agent_end event. */
export function readUsage(event: AgentSessionEvent): TokenUsage | undefined {
  if (event.type !== "agent_end") return undefined;
  for (const raw of event.messages) {
    const message = raw as { role?: string; usage?: unknown };
    if (message.role !== "assistant") continue;
    const usage = normalizeUsage(message.usage);
    if (usage) return usage;
  }
  return undefined;
}

/** Map a single SDK session event to zero or more wire events. */
export function mapAgentEvent(event: AgentSessionEvent): WireEvent[] {
  switch (event.type) {
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent;
      if (
        assistantEvent &&
        assistantEvent.type === "text_delta" &&
        typeof assistantEvent.delta === "string"
      ) {
        return [{ type: "text_delta", text: assistantEvent.delta }];
      }
      return [];
    }
    case "tool_execution_start":
      return [{ type: "tool_start", name: event.toolName, args: event.args }];
    case "tool_execution_end": {
      const out: WireEvent[] = [
        {
          type: "tool_end",
          name: event.toolName,
          isError: event.isError,
          durationMs: event.durationMs,
        },
      ];
      if (event.toolName === SEARCH_TOOL_NAME && !event.isError) {
        const grounding = extractGroundingFromResult(event.result);
        if (grounding) out.push({ type: "grounding", ...grounding });
        if (!grounding || grounding.grounded) {
          const citations = extractCitationsFromResult(event.result);
          if (citations.length > 0) out.push({ type: "citations", citations });
        }
      }
      return out;
    }
    case "agent_end": {
      const usage = readUsage(event);
      return usage ? [{ type: "usage", usage }] : [];
    }
    default:
      return [];
  }
}

export interface AgentEndInfo {
  willRetry?: boolean;
  errorMessage?: string;
}

/** Extract terminal error/retry information from an agent_end event. */
export function readAgentEndInfo(event: AgentSessionEvent): AgentEndInfo {
  if (event.type !== "agent_end") return {};
  let errorMessage: string | undefined;
  for (const raw of event.messages) {
    const message = raw as { role?: string; stopReason?: string; errorMessage?: string };
    if (
      message.role === "assistant" &&
      message.stopReason === "error" &&
      typeof message.errorMessage === "string"
    ) {
      errorMessage = message.errorMessage;
    }
  }
  return { willRetry: event.willRetry, errorMessage };
}
