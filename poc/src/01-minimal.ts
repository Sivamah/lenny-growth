import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, POC_ROOT, OLLAMA_MODEL, OLLAMA_PROVIDER, createRuntime, banner, section } from "./common.ts";

async function main(): Promise<void> {
  banner("PoC 01 - minimal session (in-memory manager, no tools, Ollama)");

  const runtime = await createRuntime();
  const model = runtime.getModel(OLLAMA_PROVIDER, OLLAMA_MODEL);
  if (!model) {
    throw new Error(`Model ${OLLAMA_PROVIDER}/${OLLAMA_MODEL} not found in ModelRuntime`);
  }
  section("resolved model");
  console.log(`${model.provider}/${model.id}`);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: POC_ROOT,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  if (modelFallbackMessage) console.log("[modelFallbackMessage]", modelFallbackMessage);

  let streamed = "";
  const eventTypes: string[] = [];
  const unsub = session.subscribe((event: any) => {
    eventTypes.push(event.type);
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      streamed += event.assistantMessageEvent.delta;
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "agent_settled") {
      console.log(`\n[agent_settled] aborted=${event.aborted}`);
    }
  });

  try {
    section("prompt");
    await session.prompt("Reply with exactly one word: PONG");
    section("results");
    console.log("getLastAssistantText:", JSON.stringify(session.getLastAssistantText()));
    console.log("streamed chars:", streamed.length);
    console.log("message count:", session.messages.length);
    console.log("event types:", JSON.stringify([...new Set(eventTypes)]));
  } finally {
    unsub();
    session.dispose();
    console.log("\n[session disposed]");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
