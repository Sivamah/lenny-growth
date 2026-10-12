import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, POC_ROOT, createRuntime, banner, section } from "./common.ts";

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;

  if (!key) {
    banner("PoC 04 - Anthropic (SKIPPED)");
    console.log("ANTHROPIC_API_KEY is not set in this environment.");
    console.log("This is a graceful skip, not a failure. Set the variable and re-run:");
    console.log("  $env:ANTHROPIC_API_KEY=\"sk-ant-...\"; npx tsx src/04-anthropic.ts");
    process.exit(0);
  }

  banner("PoC 04 - Anthropic (cloud provider via ANTHROPIC_API_KEY)");
  console.log("key present: yes (value not printed)");

  const runtime = await createRuntime();

  section("available anthropic models (first 10)");
  const models = runtime.getModels("anthropic");
  console.log(models.map((m) => m.id).slice(0, 10).join(", ") || "(none)");

  const model = models[0];
  if (!model) throw new Error("No Anthropic models available in catalog");

  const { session } = await createAgentSession({
    cwd: POC_ROOT,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });

  let streamed = "";
  const unsub = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      streamed += event.assistantMessageEvent.delta;
    }
  });

  let promptError: string | undefined;
  try {
    section(`prompt (model ${model.provider}/${model.id})`);
    await session.prompt("Reply with exactly one word: PONG");
  } catch (err: any) {
    promptError = err?.message ?? String(err);
  } finally {
    unsub();
    session.dispose();
  }

  section("results");
  console.log("streamed text:", JSON.stringify(streamed));
  console.log("getLastAssistantText:", JSON.stringify(session.getLastAssistantText()));
  if (promptError) {
    console.log("prompt error:", promptError);
    process.exitCode = 2;
  } else {
    console.log("RESULT:", streamed.trim().length > 0 ? "PASS" : "FAIL (empty response)");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
