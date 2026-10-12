import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  extractCitationsFromResult,
  extractGroundingFromResult,
  mapAgentEvent,
  normalizeUsage,
  readAgentEndInfo,
  readUsage,
  type WireEvent,
} from "../src/events.ts";

function asEvent(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function citationsEvent(wires: WireEvent[]): Extract<WireEvent, { type: "citations" }> {
  const found = wires.find((wire) => wire.type === "citations");
  assert.ok(found, "expected a citations wire event");
  return found as Extract<WireEvent, { type: "citations" }>;
}

test("text_delta maps to a text_delta wire event", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    }),
  );
  assert.deepEqual(wires, [{ type: "text_delta", text: "Hello" }]);
});

test("non-text message_update yields nothing", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
    }),
  );
  assert.deepEqual(wires, []);
});

test("tool_execution_start maps to tool_start", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "search_transcripts",
      args: { query: "pricing" },
    }),
  );
  assert.deepEqual(wires, [
    { type: "tool_start", name: "search_transcripts", args: { query: "pricing" } },
  ]);
});

test("search_transcripts result yields tool_end plus citations", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "search_transcripts",
      isError: false,
      durationMs: 42,
      result: {
        content: [{ type: "text", text: "{\"results\":[]}" }],
        details: {
          query: "pricing",
          source: "mock",
          results: [
            {
              guest: "Ada Cohen",
              episode_title: "Pricing That Works",
              timestamp: "00:12:34",
              source_url: "https://example.com/pricing",
              content: "Raise prices by anchoring on value.",
              score: 0.81,
            },
          ],
        },
      },
    }),
  );

  assert.equal(wires.length, 2);
  assert.deepEqual(wires[0], {
    type: "tool_end",
    name: "search_transcripts",
    isError: false,
    durationMs: 42,
  });
  const citations = citationsEvent(wires);
  assert.equal(citations.citations.length, 1);
  assert.equal(citations.citations[0]?.guest, "Ada Cohen");
  assert.equal(citations.citations[0]?.episode, "Pricing That Works");
  assert.equal(citations.citations[0]?.url, "https://example.com/pricing");
  assert.equal(citations.citations[0]?.score, 0.81);
});

test("non-search tool does not emit citations", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "read",
      isError: false,
      result: { content: [], details: { results: [{ guest: "x" }] } },
    }),
  );
  assert.equal(wires.length, 1);
  assert.equal(wires[0]?.type, "tool_end");
});

test("search_transcripts result emits a grounding event", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_end",
      toolCallId: "call-3",
      toolName: "search_transcripts",
      isError: false,
      result: {
        content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
        details: { query: "pricing", source: "fastapi", grounded: true, max_score: 0.72 },
      },
    }),
  );
  const found = wires.find(
    (wire): wire is Extract<WireEvent, { type: "grounding" }> => wire.type === "grounding",
  );
  assert.ok(found, "expected a grounding wire event");
  assert.equal(found.grounded, true);
  assert.equal(found.maxScore, 0.72);
});

test("grounding event is absent when the tool reports no grounded flag", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_end",
      toolCallId: "call-4",
      toolName: "search_transcripts",
      isError: false,
      result: { content: [], details: { query: "x", source: "fastapi", error: "boom" } },
    }),
  );
  assert.ok(
    wires.every((wire) => wire.type !== "grounding"),
    "no grounding event expected",
  );
});

test("search_transcripts with grounded=false emits grounding but suppresses citations", () => {
  const payload = {
    query: "quantum computing",
    source: "fastapi",
    grounded: false,
    max_score: 0.35,
    results: [
      {
        guest: "Amol Avasare",
        episode_title: "Anthropic",
        source_url: null,
        content: "Unrelated chunk.",
        score: 0.35,
      },
    ],
  };
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_end",
      toolCallId: "call-4b",
      toolName: "search_transcripts",
      isError: false,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: {
          query: payload.query,
          source: payload.source,
          grounded: payload.grounded,
          max_score: payload.max_score,
          returned: 1,
        },
      },
    }),
  );
  const grounding = wires.find(
    (wire): wire is Extract<WireEvent, { type: "grounding" }> => wire.type === "grounding",
  );
  assert.ok(grounding, "expected grounding event");
  assert.equal(grounding.grounded, false);
  assert.equal(grounding.maxScore, 0.35);
  const citations = wires.find((wire) => wire.type === "citations");
  assert.equal(citations, undefined, "citations must be suppressed when grounded is false");
});

test("real tool shape (results only in content, flags only in details) yields both citations and grounding", () => {
  const payload = {
    query: "retention",
    source: "fastapi",
    grounded: true,
    max_score: 0.72,
    results: [
      {
        guest: "Jason Cohen",
        episode_title: "5 questions",
        source_url: null,
        content: "Retention drops after onboarding.",
        score: 0.72,
      },
    ],
  };
  const wires = mapAgentEvent(
    asEvent({
      type: "tool_execution_end",
      toolCallId: "call-5",
      toolName: "search_transcripts",
      isError: false,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: {
          query: payload.query,
          source: payload.source,
          grounded: payload.grounded,
          max_score: payload.max_score,
          returned: 1,
        },
      },
    }),
  );
  const citations = wires.find((wire): wire is Extract<WireEvent, { type: "citations" }> => wire.type === "citations");
  assert.ok(citations, "expected citations despite results living only in content");
  assert.equal(citations.citations.length, 1);
  assert.equal(citations.citations[0]?.guest, "Jason Cohen");
  const grounding = wires.find((wire): wire is Extract<WireEvent, { type: "grounding" }> => wire.type === "grounding");
  assert.ok(grounding, "expected a grounding event");
  assert.equal(grounding.grounded, true);
  assert.equal(grounding.maxScore, 0.72);
});

test("extractGroundingFromResult reads max_score and guards non-boolean grounded", () => {
  assert.deepEqual(
    extractGroundingFromResult({ details: { grounded: false, max_score: 0.4 } }),
    { grounded: false, maxScore: 0.4 },
  );
  assert.deepEqual(extractGroundingFromResult({ details: { grounded: true } }), {
    grounded: true,
  });
  assert.equal(extractGroundingFromResult({ details: {} }), undefined);
  assert.equal(extractGroundingFromResult({ something: "else" }), undefined);
});

test("agent_end with assistant usage emits a usage wire event", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "agent_end",
      willRetry: false,
      messages: [
        {
          role: "assistant",
          usage: {
            input: 120,
            output: 45,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 165,
            cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
          },
        },
      ],
    }),
  );
  assert.equal(wires.length, 1);
  const usage = wires[0] as Extract<WireEvent, { type: "usage" }>;
  assert.equal(usage.type, "usage");
  assert.equal(usage.usage.input, 120);
  assert.equal(usage.usage.totalTokens, 165);
  assert.equal(usage.usage.cost?.total, 0.03);
});

test("agent_end without assistant usage emits nothing", () => {
  const wires = mapAgentEvent(
    asEvent({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
    }),
  );
  assert.deepEqual(wires, []);
});

test("readUsage picks the first assistant usage; normalizeUsage guards malformed blobs", () => {
  assert.equal(
    readUsage(asEvent({ type: "turn_start" })),
    undefined,
  );
  assert.equal(
    readUsage(asEvent({ type: "agent_end", willRetry: false, messages: [{ role: "user" }] })),
    undefined,
  );
  assert.equal(normalizeUsage(null), undefined);
  assert.equal(normalizeUsage("usage"), undefined);
  assert.deepEqual(normalizeUsage({ output: 5 }), { input: 0, output: 5, totalTokens: 5, cacheRead: undefined, cacheWrite: undefined, reasoning: undefined, cost: null });
});

test("extractCitationsFromResult falls back to parsing text content", () => {
  const citations = extractCitationsFromResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [{ guest: "Bo", source_url: "https://x", content: "hello" }],
        }),
      },
    ],
    details: undefined,
  });
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.guest, "Bo");
});

test("readAgentEndInfo extracts an error stop reason", () => {
  const info = readAgentEndInfo(
    asEvent({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider exploded" }],
    }),
  );
  assert.equal(info.errorMessage, "provider exploded");
  assert.equal(info.willRetry, false);
});

test("readAgentEndInfo returns empty for non-agent_end events", () => {
  assert.deepEqual(readAgentEndInfo(asEvent({ type: "turn_start" })), {});
});
