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
  banner("PoC 02 - custom tool (defineTool + search_transcripts)");

  const runtime = await createRuntime();
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

  section("active tools");
  console.log(JSON.stringify(session.getActiveToolNames?.() ?? []));

  const eventTypes: string[] = [];
  let toolStarts = 0;
  let toolEnds = 0;
  let assistantText = "";

  const unsub = session.subscribe((event: any) => {
    eventTypes.push(event.type);
    if (event.type === "tool_execution_start") {
      toolStarts++;
      console.log(`[tool_execution_start] ${event.toolName} args=${JSON.stringify(event.args)}`);
    }
    if (event.type === "tool_execution_end") {
      toolEnds++;
      console.log(`[tool_execution_end] ${event.toolName} isError=${event.isError}`);
      console.log(`   result=${JSON.stringify(event.result)?.slice(0, 400)}`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      assistantText += event.assistantMessageEvent.delta;
    }
  });

  try {
    section("prompt (forces a tool call)");
    await session.prompt(
      "Use the search_transcripts tool to find what the podcast says about pricing. " +
        "Then summarize the finding in one sentence."
    );
    section("results");
    console.log("tool_execution_start count:", toolStarts);
    console.log("tool_execution_end count:", toolEnds);
    console.log("assistant text:", JSON.stringify(assistantText));
    console.log("getLastAssistantText:", JSON.stringify(session.getLastAssistantText()));
    console.log("event types:", JSON.stringify([...new Set(eventTypes)]));
  } finally {
    unsub();
    session.dispose();
  }

  console.log("\nRESULT:", toolStarts > 0 ? "PASS - custom tool was invoked" : "FAIL - no tool call observed");
  if (toolStarts === 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
