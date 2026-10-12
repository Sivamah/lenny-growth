import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../src/config.ts";
import type { WireEvent } from "../src/events.ts";
import {
  buildRecoveryPrompt,
  classifyPartialLeak,
  parseLeakedQuery,
  runChatTurn,
  SEARCH_TRANSCRIPTS,
  stripToolCallLeaks,
  type ChatSession,
} from "../src/chat.ts";
import type { RetrievalResult } from "../src/retrieval.ts";

/** Retrieval-config object that hits the deterministic mock stub (no network). */
function makeCfg(): AgentConfig {
  return {
    host: "127.0.0.1",
    port: 8001,
    agentDir: ".",
    cwd: ".",
    ollama: { nativeBaseUrl: "http://localhost:11434", openAiBaseUrl: "http://localhost:11434/v1", model: "llama3.2:3b" },
    anthropic: { enabled: false, model: "claude-sonnet-4-5-20250929" },
    retrieval: {
      url: "http://localhost:8000/internal/retrieve",
      topK: 5,
      mock: true,
      timeoutMs: 5000,
      minScore: 0.6,
    },
  };
}

// ---------------------------------------------------------------------------
// classifyPartialLeak
// ---------------------------------------------------------------------------

const LEAK = `{"name":"search_transcripts","parameters":{"query":"distribution moat","top_k":1}}`;

test("classifyPartialLeak: a lone known-tool JSON object is a leak", () => {
  const c = classifyPartialLeak(LEAK);
  assert.equal(c.state, "leak");
  if (c.state === "leak") {
    assert.equal(c.name, SEARCH_TRANSCRIPTS);
    assert.equal((c.parameters as { query?: string }).query, "distribution moat");
  }
});

test("classifyPartialLeak: whitespace/newlines around the object are still a leak", () => {
  const c = classifyPartialLeak(` \n\t${LEAK}\n `);
  assert.equal(c.state, "leak");
});

test("classifyPartialLeak: an unclosed JSON fragment is undecided", () => {
  assert.equal(classifyPartialLeak(`{"name":"search_transcripts","parameters":`).state, "undecided");
  assert.equal(classifyPartialLeak(`{"name":"search_transcripts"`).state, "undecided");
});

test("classifyPartialLeak: prose is always an answer", () => {
  assert.equal(classifyPartialLeak("Distribution is the moat that compounds.").state, "answer");
});

test("classifyPartialLeak: text after the JSON closes is an answer", () => {
  const c = classifyPartialLeak(`${LEAK} And here is what the guest said...`);
  assert.equal(c.state, "answer");
});

test("classifyPartialLeak: an unknown tool name is not treated as a leak", () => {
  assert.equal(classifyPartialLeak(`{"name":"write_file","parameters":{"path":"x"}}`).state, "answer");
});

test("classifyPartialLeak: valid JSON without parameters is not a leak", () => {
  assert.equal(classifyPartialLeak(`{"name":"search_transcripts"}`).state, "answer");
});

test("classifyPartialLeak: JSON with escaped quotes inside does not break the scanner", () => {
  const tricky = `{"name":"search_transcripts","parameters":{"query":"say \\"hi\\" there"}}`;
  const c = classifyPartialLeak(tricky);
  assert.equal(c.state, "leak");
});

// Real samples captured from the live benchmark (#3, #8, #25, #39, pre-fix).
test("classifyPartialLeak: real captured leaks classify as leaks", () => {
  const samples: Array<[string, string | undefined]> = [
    // #3: malformed `"parameters"=` (equals sign instead of colon).
    [`{"name":"search_transcripts","parameters={"query":"Distribution as most important moat Evan Spiegel","top_k":1}}`, "Distribution as most important moat Evan Spiegel"],
    // #8: valid JSON but the query value is double-quoted as a string.
    [`{"name":"search_transcripts","parameters":{"query":"\\"hidden pattern behind successful products according to Mark Pincus\\"","top_k":"1"}}`, "hidden pattern behind successful products according to Mark Pincus"],
    // #25 (turn 2): malformed `"parameters"=` again.
    [`{"name":"search_transcripts","parameters={"query":"HubSpot distribution","top_k":10}}`, "HubSpot distribution"],
    // #39: well-formed object embedded in a larger draft.
    [`{"name":"search_transcripts","parameters":{"query":"the role of retention in business strategy","top_k":"3"}}`, "the role of retention in business strategy"],
  ];
  for (const [sample, query] of samples) {
    const c = classifyPartialLeak(sample);
    assert.equal(c.state, "leak", sample);
    if (c.state === "leak" && query !== undefined) {
      assert.equal(c.name, SEARCH_TRANSCRIPTS);
      assert.equal(parseLeakedQuery(c.parameters), query, sample);
    }
  }
});

// ---------------------------------------------------------------------------
// stripToolCallLeaks
// ---------------------------------------------------------------------------

test("stripToolCallLeaks removes embedded tool-call JSON but keeps prose", () => {
  const dirty =
    "}".repeat(0) +
    `  \n\n {"name": "search_transcripts","parameters": {"query": "building a strong customer base through retention", "top_k": "3"}}  \n\n` +
    "Retention is the real moat. ";
  assert.equal(stripToolCallLeaks(dirty), "Retention is the real moat.");
});

test("stripToolCallLeaks removes multiple leaks and keeps non-tool JSON", () => {
  const dirty =
    `{"name":"search_transcripts","parameters={"query":"HubSpot distribution","top_k":10}}` +
    "  " +
    `{"name":"search_transcripts","parameters":{"query":"the role of retention","top_k":"3"}}` +
    "\n\nHere is my answer. Config stays: " +
    `{"name":"not_a_tool","value":1}`;
  const clean = stripToolCallLeaks(dirty);
  assert.equal(clean, "Here is my answer. Config stays: " + `{"name":"not_a_tool","value":1}`);
});

test("stripToolCallLeaks leaves plain essay text untouched", () => {
  const essay = "Hooks matter.\n\n## One\n\n**Bold** the pivotal idea.";
  assert.equal(stripToolCallLeaks(essay), essay);
});

// ---------------------------------------------------------------------------
// parseLeakedQuery
// ---------------------------------------------------------------------------

test("parseLeakedQuery extracts the query and unquotes over-quoted values", () => {
  assert.equal(
    parseLeakedQuery({ query: "how to price a product" }),
    "how to price a product",
  );
  assert.equal(
    parseLeakedQuery({ query: '"what does the corpus say about retention"' }),
    "what does the corpus say about retention",
  );
  assert.equal(parseLeakedQuery({ query: "   spaced   " }), "spaced");
  assert.equal(parseLeakedQuery({ query: 42 }), undefined);
  assert.equal(parseLeakedQuery(undefined), undefined);
});

// ---------------------------------------------------------------------------
// buildRecoveryPrompt
// ---------------------------------------------------------------------------

function evidence(grounded: boolean): RetrievalResult {
  return {
    query: "distribution moat",
    grounded,
    max_score: grounded ? 0.7 : 0.4,
    results: [
      {
        transcript_slug: "marc-andreessen",
        episode_title: "Marc Andreessen: The real AI boom",
        guest: "Marc Andreessen",
        timestamp: "00:12:30",
        source_url: "https://example.com/ep",
        content: "Distribution is the moat.",
        score: grounded ? 0.7 : 0.4,
      },
    ],
    source: "fastapi",
  };
}

test("buildRecoveryPrompt keeps claims grounded and forbids re-calling the tool", () => {
  const prompt = buildRecoveryPrompt("Why is distribution a moat?", evidence(true));
  assert.match(prompt, /"distribution moat"/);
  assert.match(prompt, /Marc Andreessen/);
  assert.match(prompt, /do NOT call search_transcripts/i);
  assert.match(prompt, /User question: Why is distribution a moat\?/);
});

test("buildRecoveryPrompt with grounded=false instructs honesty", () => {
  const prompt = buildRecoveryPrompt("Why is distribution a moat?", evidence(false));
  assert.match(prompt, /below the grounding threshold|do not cover/i);
});

// ---------------------------------------------------------------------------
// runChatTurn with a deterministic fake session
// ---------------------------------------------------------------------------

type MaybeAgentEvent = Record<string, unknown> & { type: string };

class FakeSession implements ChatSession {
  timesPrompted = 0;
  private listener: ((event: MaybeAgentEvent) => void) | null = null;

  constructor(private readonly deltasPerPrompt: string[][]) {}

  subscribe(
    listener: (event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => void,
  ): () => void {
    this.listener = listener as (event: MaybeAgentEvent) => void;
    return () => {
      this.listener = null;
    };
  }

  async prompt(): Promise<void> {
    const nth = this.timesPrompted;
    this.timesPrompted += 1;
    const deltas = this.deltasPerPrompt[nth] ?? [];
    for (const delta of deltas) {
      this.listener?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      } as unknown as MaybeAgentEvent);
    }
    this.listener?.({
      type: "agent_end",
      messages: [],
      willRetry: false,
    } as unknown as MaybeAgentEvent);
    this.listener?.({
      type: "agent_settled",
      aborted: false,
    } as unknown as MaybeAgentEvent);
  }
}

const LEAK_QUERY = "distribution moat";

interface Sink {
  events: WireEvent[];
  text: string;
}

function collector(): { sink: Sink; onWire: (wire: WireEvent) => void } {
  const sink: Sink = { events: [], text: "" };
  const onWire = (wire: WireEvent): void => {
    sink.events.push(wire);
    if (wire.type === "text_delta") sink.text += wire.text;
  };
  return { sink, onWire };
}

test("runChatTurn: a leaked tool call is suppressed and recovered with a real answer", async () => {
  const session = new FakeSession([
    [`{"name":"search_transcripts","parameters":{"query":"${LEAK_QUERY}","top_k":1}}`],
    ["The evidence says ", "distribution is the moat."],
  ]);
  const { sink, onWire } = collector();
  const result = await runChatTurn(makeCfg(), session, "Why is distribution a moat?", onWire);

  const tools = sink.events.filter((e) => e.type === "tool_start");
  assert.equal(tools.length, 1);
  const tool = tools[0] as Extract<WireEvent, { type: "tool_start" }>;
  assert.equal(tool.name, SEARCH_TRANSCRIPTS);
  assert.equal((tool.args as { query?: string }).query, LEAK_QUERY);

  assert.ok(sink.events.some((e) => e.type === "tool_end" && e.isError === false));
  assert.ok(sink.events.some((e) => e.type === "citations"));
  assert.ok(sink.events.some((e) => e.type === "grounding"));

  // The JSON leak never surfaces as user-visible text.
  assert.ok(!sink.text.includes('"name":'), `leaked JSON reached the stream: ${sink.text}`);
  assert.equal(sink.text, "The evidence says distribution is the moat.");
  assert.equal(result.text, sink.text);
  assert.equal(result.recovered, true);
  assert.equal(session.timesPrompted, 2);
});

test("runChatTurn: normal prose streams and never recovers", async () => {
  const session = new FakeSession([["Distribution is ", "the compounding moat."]]);
  const { sink, onWire } = collector();
  const result = await runChatTurn(makeCfg(), session, "Hello", onWire);

  assert.equal(sink.text, "Distribution is the compounding moat.");
  assert.equal(result.text, sink.text);
  assert.equal(result.recovered, false);
  assert.equal(session.timesPrompted, 1);
  assert.ok(!sink.events.some((e) => e.type === "tool_start"));
});

test("runChatTurn: an answer that starts with JSON but continues is not treated as a leak", async () => {
  const session = new FakeSession([
    [
      `{"name":"search_transcripts","parameters":{"query":"x"}}`,
      "\nThe guest said distribution is the moat.",
    ],
  ]);
  const { sink, onWire } = collector();
  const result = await runChatTurn(makeCfg(), session, "Tell me", onWire);

  assert.equal(result.recovered, false);
  assert.match(result.text, /The guest said distribution is the moat\./);
  assert.equal(session.timesPrompted, 1);
});

test("runChatTurn: a double leak falls back to an evidence summary instead of JSON", async () => {
  const session = new FakeSession([
    [`{"name":"search_transcripts","parameters":{"query":"${LEAK_QUERY}","top_k":1}}`],
    [`{"name":"search_transcripts","parameters":{"query":"${LEAK_QUERY}","top_k":2}}`],
  ]);
  const { sink, onWire } = collector();
  const result = await runChatTurn(makeCfg(), session, "Explain the moat", onWire);

  assert.equal(result.recovered, true);
  // Mock retrieval reports grounded=false, so the fallback is honest: it says
  // the transcripts do not clearly cover the topic instead of inventing facts.
  assert.match(result.text, /does not clearly cover this topic/i);
  assert.ok(!result.text.includes('"name":'), `leaked JSON reached the final text: ${result.text}`);
  assert.equal(session.timesPrompted, 2);
});