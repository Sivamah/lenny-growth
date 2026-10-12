import { BASE_URL, ApiError } from "./client";
import type {
  ApiErrorBody,
  ChatEvent,
  Citation,
  Grounding,
  TokenUsage,
  TurnEndData,
} from "../types";

// ---------------------------------------------------------------------------
// Incremental SSE framing. The backend writes each event as:
//   `event: <type>\ndata: <json>\n\n`
// Frames arrive split across arbitrary network chunks, so we buffer and only
// emit complete frames (terminated by a blank line). CRLF is normalised.
// ---------------------------------------------------------------------------

export interface SseFrame {
  event: string;
  data: string;
}

export class SseBufferParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    return this.consume();
  }

  flush(): SseFrame[] {
    return this.consume(true);
  }

  private consume(force = false): SseFrame[] {
    const frames: SseFrame[] = [];
    while (true) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (block.trim() !== "") frames.push(this.parseBlock(block));
    }
    if (force && this.buffer.trim() !== "") {
      frames.push(this.parseBlock(this.buffer));
      this.buffer = "";
    }
    return frames;
  }

  private parseBlock(block: string): SseFrame {
    const data: string[] = [];
    let event = "message";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.startsWith(":")) continue; // SSE comment
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).trimStart());
      }
    }
    return { event, data: data.join("\n") };
  }
}

export function parseSseFrame(frame: SseFrame): ChatEvent | null {
  if (frame.data === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return { type: "error", data: { message: "Malformed event payload from the server.", retryable: false } };
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const data = parsed as Record<string, unknown>;
  switch (frame.event) {
    case "turn_start":
      return {
        type: "turn_start",
        data: { model: data.model as string | null, provider: data.provider as string | null },
      };
    case "text_delta":
      return {
        type: "text_delta",
        data: { text: typeof data.text === "string" ? data.text : "" },
      };
    case "tool_start":
    case "tool_end":
      return { type: frame.event, data };
    case "citations":
      return {
        type: "citations",
        data: { citations: normalizeCitations(data.citations) },
      };
    case "grounding":
      return {
        type: "grounding",
        data: {
          grounded: data.grounded === true,
          max_score: typeof data.max_score === "number" ? data.max_score : null,
        },
      };
    case "usage":
      return {
        type: "usage",
        data: { usage: typeof data.usage === "object" && data.usage !== null ? (data.usage as TokenUsage) : null },
      };
    case "error":
      return {
        type: "error",
        data: {
          message: typeof data.message === "string" ? data.message : "The assistant reported an error.",
          retryable: data.retryable === true,
        },
      };
    case "turn_end":
      return {
        type: "turn_end",
        data: {
          stop_reason: typeof data.stop_reason === "string" ? data.stop_reason : "stop",
          message_id: typeof data.message_id === "string" ? data.message_id : null,
          grounded: typeof data.grounded === "boolean" ? data.grounded : null,
          provider: typeof data.provider === "string" ? data.provider : null,
          model: typeof data.model === "string" ? data.model : null,
        },
      };
    case "artifact":
      return {
        type: "artifact",
        data: {
          id: typeof data.id === "string" ? data.id : "",
          kind: data.kind === "html" ? "html" : "markdown",
          title: typeof data.title === "string" ? data.title : null,
          content: typeof data.content === "string" ? data.content : undefined,
          message_id: typeof data.message_id === "string" ? data.message_id : null,
        }
      };
    default:
      return null;
  }
}

function normalizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const result: Citation[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    result.push({
      guest: typeof c.guest === "string" ? c.guest : null,
      episode: typeof c.episode === "string" ? c.episode : null,
      timestamp: typeof c.timestamp === "string" ? c.timestamp : null,
      url: typeof c.url === "string" && c.url !== "" ? c.url : null,
      snippet: typeof c.snippet === "string" ? c.snippet : null,
      score: typeof c.score === "number" ? c.score : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Streaming client for POST /api/chat.
// ---------------------------------------------------------------------------

export interface ChatTurnSummary {
  stopReason: string;
  messageId: string | null;
  grounded: boolean | null;
  model: string | null;
  provider: string | null;
  usage: TokenUsage | null;
  errorMessage: string | null;
  retryable: boolean;
}

export interface StreamChatOptions {
  signal: AbortSignal;
  onEvent?: (event: ChatEvent) => void;
  /** Optional explicit skill (e.g. "ship30_essay"). The backend also detects it from the message. */
  skill?: string;
}

/**
 * Stream one assistant turn over `POST /api/chat`.
 *
 * Resolves with the aggregated turn summary once the stream ends normally,
 * including runs that ended via an SSE `error` event (structured error). It
 * rejects when the request itself failed (network error, HTTP status != 200,
 * or an abort via the AbortSignal). An HTTP error is never treated as a
 * successful assistant response.
 */
export async function streamChat(
  sessionId: string,
  message: string,
  options: StreamChatOptions,
): Promise<ChatTurnSummary> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        message,
        ...(options.skill ? { skill: options.skill } : {}),
      }),
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "Could not reach the backend API while streaming the response.");
  }

  if (!res.ok || !res.body) {
    let message = `Chat request failed (${res.status}). Your message may have been saved.`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new ApiError(res.status, message);
  }

  const parser = new SseBufferParser();
  const summary: ChatTurnSummary = {
    stopReason: "stop",
    messageId: null,
    grounded: null,
    model: null,
    provider: null,
    usage: null,
    errorMessage: null,
    retryable: false,
  };
  let sawTurnEnd = false;
  let sawError = false;

  const handleFrame = (frame: SseFrame) => {
    const event = parseSseFrame(frame);
    if (event === null) return;
    options.onEvent?.(event);
    switch (event.type) {
      case "turn_start":
        summary.model = event.data.model;
        summary.provider = event.data.provider;
        break;
      case "grounding":
        summary.grounded = event.data.grounded;
        break;
      case "usage":
        summary.usage = event.data.usage;
        break;
      case "error":
        sawError = true;
        summary.errorMessage = event.data.message;
        summary.retryable = event.data.retryable;
        break;
      case "turn_end": {
        sawTurnEnd = true;
        const end = event.data as TurnEndData;
        summary.stopReason = end.stop_reason;
        summary.messageId = end.message_id;
        if (end.grounded !== null) summary.grounded = end.grounded;
        if (end.model) summary.model = end.model;
        if (end.provider) summary.provider = end.provider;
        break;
      }
      default:
        break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        handleFrame(frame);
      }
    }
    for (const frame of parser.flush()) {
      handleFrame(frame);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "Read error while streaming the assistant response.");
  } finally {
    reader.releaseLock();
  }

  if (!sawTurnEnd && !sawError) {
    // Stream ended without a closing event — treat as an abnormal completion
    // rather than claiming a successful response.
    summary.stopReason = "error";
    summary.errorMessage = "The assistant stream ended before completing its reply.";
    summary.retryable = true;
  }

  return summary;
}

export function groundingFromMessage(grounding: Grounding | null): {
  grounded: boolean | null;
  maxScore: number | null;
} {
  if (!grounding) return { grounded: null, maxScore: null };
  return { grounded: grounding.grounded, maxScore: grounding.max_score };
}