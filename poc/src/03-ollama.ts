import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, POC_ROOT, OLLAMA_MODEL, OLLAMA_PROVIDER, createRuntime, banner, section } from "./common.ts";

const CHUNKS = [
  {
    episode: "Lenny's Podcast - Pricing That Works",
    speaker: "Guest",
    timestamp: "00:12:34",
    url: "https://example.com/pricing",
    text: "We raised prices by 3x by anchoring on value delivered to the customer, not on competitor pricing.",
  },
  {
    episode: "Lenny's Podcast - Growth Loops",
    speaker: "Host",
    timestamp: "00:03:02",
    url: "https://example.com/growth",
    text: "Retention is the single most important metric for durable growth in consumer products.",
  },
];

const searchTool = defineTool({
  name: "search_transcripts",
  label: "Search Transcripts",
  description:
    "Search Lenny's Podcast transcripts. Returns episode, speaker, timestamp, url, and matching text chunks.",
  promptSnippet: "Search Lenny's Podcast transcripts for relevant teaching chunks",
  promptGuidelines: [
    "Use search_transcripts whenever the user asks what the podcast says about a topic.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Natural-language search query" }),
    top_k: Type.Optional(Type.Number({ description: "Maximum results to return", default: 3 })),
  }),
  execute: async (_toolCallId: string, params: { query: string; top_k?: number }) => {
    const topK = params.top_k ?? 3;
    const results = CHUNKS.slice(0, topK);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ query: params.query, results }) }],
      details: { query: params.query, returned: results.length },
    };
  },
});

async function main(): Promise<void> {
  banner("PoC 03 - real Ollama integration (models.json -> ModelRuntime -> generation + tool call)");

  const runtime = await createRuntime();

  section("providers visible to ModelRuntime");
  console.log(runtime.getProviders().map((p) => p.id ?? (p as any).providerId).join(", "));

  section("ollama models registered from agentdir/models.json");
  const ollamaModels = runtime.getModels(OLLAMA_PROVIDER);
  console.log(ollamaModels.map((m) => m.id).join(", ") || "(none)");

  const model = runtime.getModel(OLLAMA_PROVIDER, OLLAMA_MODEL);
  if (!model) throw new Error(`Model ${OLLAMA_PROVIDER}/${OLLAMA_MODEL} not found`);

  const { session } = await createAgentSession({
    cwd: POC_ROOT,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    tools: ["search_transcripts"],
    customTools: [searchTool],
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });

  let toolStarts = 0;
  let assistantText = "";
  const unsub = session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      toolStarts++;
      console.log(`[tool_execution_start] ${event.toolName} args=${JSON.stringify(event.args)}`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      assistantText += event.assistantMessageEvent.delta;
    }
  });

  const start = Date.now();
  let promptError: string | undefined;
  try {
    section("prompt");
    await session.prompt(
      "Search the transcripts for pricing advice using the search_transcripts tool, " +
        "then answer: what was the key pricing insight? Cite the episode."
    );
    section("streamed answer");
    console.log(assistantText);
  } catch (err: any) {
    promptError = err?.message ?? String(err);
  } finally {
    unsub();
    session.dispose();
  }

  const elapsedMs = Date.now() - start;
  section("verdict");
  const hasResponse = assistantText.trim().length > 0;
  const toolInvoked = toolStarts > 0;
  const grounded = /3x|value|competitor|pricing/i.test(assistantText);

  console.log(`elapsed_ms            = ${elapsedMs}`);
  console.log(`real response         = ${hasResponse} (chars=${assistantText.trim().length})`);
  console.log(`tool invoked          = ${toolInvoked} (count=${toolStarts})`);
  console.log(`answer references seed= ${grounded}`);
  if (promptError) console.log(`prompt error          = ${promptError}`);

  const pass = hasResponse && toolInvoked;
  console.log("\nRESULT:", pass ? "PASS" : "PARTIAL/FAIL");
  if (!pass) process.exitCode = 2;
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
