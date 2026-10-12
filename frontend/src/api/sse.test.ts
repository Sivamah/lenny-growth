import { describe, expect, it, vi } from "vitest";
import { parseSseFrame, SseBufferParser, streamChat } from "./sse";

describe("SseBufferParser", () => {
  it("parses a single complete frame", () => {
    const parser = new SseBufferParser();
    const frames = parser.push("event: text_delta\ndata: {\"text\": \"hi\"}\n\n");
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual({ event: "text_delta", data: '{"text": "hi"}' });
  });

  it("accumulates frames split across arbitrary chunk boundaries", () => {
    const parser = new SseBufferParser();
    const all = 'event: text_delta\ndata: {"text": "Z"}\n\nevent: text_delta\ndata: {"text": "QX"}\n\nevent: turn_end\ndata: {"stop_reason": "stop", "message_id": "m1"}\n\n';
    const frames: Array<{ event: string; data: string }> = [];
    // Feed one character at a time to simulate worst-case TCP fragmentation.
    for (const ch of all) frames.push(...parser.push(ch));
    expect(frames.map((f) => f.event)).toEqual(["text_delta", "text_delta", "turn_end"]);
  });

  it("flushes a final frame that has no trailing blank line", () => {
    const parser = new SseBufferParser();
    expect(parser.push("event: turn_end\ndata: {\"stop_reason\": \"stop\"}")).toEqual([]);
    const flushed = parser.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0].event).toBe("turn_end");
  });

  it("normalises CRLF and ignores SSE comment lines", () => {
    const parser = new SseBufferParser();
    const frames = parser.push(": keep-alive comment\r\nevent: grounding\r\ndata: {\"grounded\": true}\r\n\r\n");
    expect(frames.length).toBe(1);
    expect(frames[0].event).toBe("grounding");
    expect(frames[0].data).toBe('{"grounded": true}');
  });
});

describe("parseSseFrame", () => {
  it("decodes each backend event type into a typed ChatEvent", () => {
    expect(parseSseFrame({ event: "turn_start", data: '{"model": "ollama/llama3.2:3b", "provider": "ollama"}' })).toEqual({
      type: "turn_start",
      data: { model: "ollama/llama3.2:3b", provider: "ollama" },
    });
    expect(parseSseFrame({ event: "text_delta", data: '{"text": "hello"}' })).toEqual({
      type: "text_delta",
      data: { text: "hello" },
    });
    expect(parseSseFrame({ event: "grounding", data: '{"grounded": true, "max_score": 0.6}' })).toEqual({
      type: "grounding",
      data: { grounded: true, max_score: 0.6 },
    });
    expect(parseSseFrame({ event: "error", data: '{"message": "boom", "retryable": true}' })).toEqual({
      type: "error",
      data: { message: "boom", retryable: true },
    });
    const end = parseSseFrame({ event: "turn_end", data: '{"stop_reason": "stop", "message_id": "m1", "grounded": true, "provider": "ollama", "model": "ollama/llama3.2:3b"}' });
    expect(end?.type).toBe("turn_end");
    if (end?.type === "turn_end") {
      expect(end.data).toMatchObject({ stop_reason: "stop", message_id: "m1", grounded: true });
    }
    const artifact = parseSseFrame({
      event: "artifact",
      data: '{"id": "art-1", "kind": "html", "title": "Dashboard", "content": "<h1>Dashboard</h1>", "message_id": "m1"}',
    });
    expect(artifact?.type).toBe("artifact");
    if (artifact?.type === "artifact") {
      expect(artifact.data).toEqual({
        id: "art-1",
        kind: "html",
        title: "Dashboard",
        content: "<h1>Dashboard</h1>",
        message_id: "m1",
      });
    }
  });

  it("normalises citation payloads and drops non-string url values", () => {
    const event = parseSseFrame({
      event: "citations",
      data: JSON.stringify({
        citations: [
          { guest: "Jason", episode: "E", timestamp: "00:10", url: "https://x.io/p", score: 0.7 },
          { guest: "No Url", episode: "E2", timestamp: "00:20", url: "", score: 0.5 },
          { guest: "Bad Score", episode: "E3", url: "https://y.io", score: "nope" },
        ],
      }),
    });
    expect(event?.type).toBe("citations");
    if (event?.type === "citations") {
      expect(event.data.citations).toEqual([
        { guest: "Jason", episode: "E", timestamp: "00:10", url: "https://x.io/p", snippet: null, score: 0.7 },
        { guest: "No Url", episode: "E2", timestamp: "00:20", url: null, snippet: null, score: 0.5 },
        { guest: "Bad Score", episode: "E3", timestamp: null, url: "https://y.io", snippet: null, score: null },
      ]);
    }
  });

  it("turns a malformed payload into a structured error instead of throwing", () => {
    const event = parseSseFrame({ event: "text_delta", data: "{not-json" });
    expect(event?.type).toBe("error");
  });

  it("ignores unknown event types", () => {
    expect(parseSseFrame({ event: "heartbeat", data: "{}" })).toBeNull();
  });
});

/**
 * Build a Response-shaped value whose body is a byte reader over `sse`.
 *
 * jsdom (the vitest environment) has no `Blob.prototype.stream`, and `Response.body`
 * there is not a real ReadableStream either, so streamChat only needs `ok`,
 * `status` and a `body.getReader()`. Passing a `signal` makes the reader behave
 * like a connection that stays open once the payload is consumed until the
 * signal aborts, so the abort path is exercised deterministically.
 */
function sseResponse(
  sse: string,
  options?: { signal?: AbortSignal },
): Pick<Response, "ok" | "status" | "body"> {
  const bytes = new TextEncoder().encode(sse);
  let offset = 0;

  const throwIfAborted = () => {
    if (options?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  };

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          releaseLock() {},
          async read() {
            throwIfAborted();
            if (offset >= bytes.length) {
              if (options?.signal) {
                await new Promise<void>((resolve) => {
                  if (options.signal!.aborted) return resolve();
                  options.signal!.addEventListener("abort", () => resolve(), { once: true });
                });
                throwIfAborted();
              }
              return { done: true, value: undefined };
            }
            const end = Math.min(offset + 9, bytes.length);
            const value = bytes.slice(offset, end);
            offset = end;
            return { done: false, value };
          },
        };
      },
    },
  } as unknown as Response;
}

describe("streamChat", () => {
  it("aggregates a full turn and never treats an HTTP error as success", async () => {
    const sse =
      'event: turn_start\ndata: {"model": "ollama/llama3.2:3b", "provider": "ollama"}\n\n' +
      'event: text_delta\ndata: {"text": "Grounded"}\n\n' +
      'event: grounding\ndata: {"grounded": true, "max_score": 0.63}\n\n' +
      'event: turn_end\ndata: {"stop_reason": "stop", "message_id": "m-1", "grounded": true, "provider": "ollama", "model": "ollama/llama3.2:3b"}\n\n';

    const fetchMock = vi.fn().mockResolvedValue(sseResponse(sse));
    vi.stubGlobal("fetch", fetchMock);

    const events: string[] = [];
    const summary = await streamChat("sess-1", "hello", {
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e.type),
    });

    expect(summary.stopReason).toBe("stop");
    expect(summary.messageId).toBe("m-1");
    expect(summary.grounded).toBe(true);
    expect(summary.model).toBe("ollama/llama3.2:3b");
    expect(events).toContain("text_delta");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ session_id: "sess-1", message: "hello" });
    vi.unstubAllGlobals();
  });

  it("rejects on a non-2xx response and surfaces the backend error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 502, message: "Agent unavailable" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      streamChat("sess-1", "hello", { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ status: 502, message: "Agent unavailable" });
    vi.unstubAllGlobals();
  });

  it("flags an abnormal stream end (no turn_end) as an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('event: text_delta\ndata: {"text": "partial"}'));
    vi.stubGlobal("fetch", fetchMock);
    const summary = await streamChat("sess-1", "hello", { signal: new AbortController().signal });
    expect(summary.stopReason).toBe("error");
    expect(summary.errorMessage).toContain("ended before completing");
    vi.unstubAllGlobals();
  });

  it("rejects with AbortError when the caller cancels mid-stream", async () => {
    const controller = new AbortController();
    const sse = 'event: text_delta\ndata: {"text": "abc"}\n\nevent: turn_end\ndata: {"stop_reason": "stop"}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(sse, { signal: controller.signal })));
    const promise = streamChat("sess-1", "hello", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });
});