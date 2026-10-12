import { loadConfig } from "../src/config.ts";
import { createAgentRuntime, defaultModel } from "../src/runtime.ts";
import { mockRetrieval } from "../src/retrieval.ts";

/**
 * Diagnostic parity with the Phase 0 PoC scratch scripts: prints the resolved
 * config, materialised ModelRuntime paths, selected model, and an Ollama probe.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const runtime = await createAgentRuntime(cfg);
  const model = defaultModel(runtime.runtime, cfg);

  console.log("config:", JSON.stringify(cfg, null, 2));
  console.log("models.json :", runtime.modelsPath);
  console.log("auth.json   :", runtime.authPath);
  console.log("default model:", `${(model as { provider?: string }).provider}/${(model as { id?: string }).id}`);

  try {
    const response = await fetch(`${cfg.ollama.nativeBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    console.log("ollama models:", JSON.stringify((data.models ?? []).map((m) => m.name)));
  } catch (error) {
    console.log("ollama probe failed:", error instanceof Error ? error.message : String(error));
  }

  console.log("mock retrieval:", JSON.stringify(mockRetrieval("pricing", 2)));
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});
