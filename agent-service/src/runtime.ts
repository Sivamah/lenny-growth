import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig } from "./config.ts";

export interface ModelsConfig {
  providers: Record<
    string,
    {
      baseUrl: string;
      api: string;
      apiKey?: string;
      models: Array<{ id: string }>;
    }
  >;
}

/**
 * Build the models.json catalogue that the Pi ModelRuntime reads.
 * The Ollama provider is expressed as an OpenAI-compatible endpoint, mirroring
 * the verified Phase 0 PoC configuration.
 */
export function buildModelsConfig(cfg: AgentConfig): ModelsConfig {
  return {
    providers: {
      ollama: {
        baseUrl: cfg.ollama.openAiBaseUrl,
        api: "openai-completions",
        apiKey: "ollama",
        models: [{ id: cfg.ollama.model }],
      },
    },
  };
}

export interface AgentRuntime {
  runtime: ModelRuntime;
  modelsPath: string;
  authPath: string;
}

/**
 * Materialise models.json/auth.json inside agentDir and create the ModelRuntime.
 * Client-side model resolution only (allowModelNetwork:false) so the service
 * never hits the network just to start.
 */
export async function createAgentRuntime(cfg: AgentConfig): Promise<AgentRuntime> {
  await mkdir(cfg.agentDir, { recursive: true });

  const modelsPath = join(cfg.agentDir, "models.json");
  const authPath = join(cfg.agentDir, "auth.json");

  await writeFile(
    modelsPath,
    `${JSON.stringify(buildModelsConfig(cfg), null, 2)}\n`,
    "utf8",
  );
  if (!existsSync(authPath)) {
    await writeFile(authPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`, "utf8");
  }

  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath,
    allowModelNetwork: false,
  });

  if (cfg.anthropic.enabled && cfg.anthropic.apiKey) {
    // Optional cloud provider. Not exercised in this environment (no API key).
    await runtime.setRuntimeApiKey("anthropic", cfg.anthropic.apiKey);
  }

  return { runtime, modelsPath, authPath };
}

export function resolveModel(runtime: ModelRuntime, provider: string, id: string): Model<any> {
  const model = runtime.getModel(provider, id);
  if (!model) {
    throw new Error(`Model "${provider}/${id}" is not available in the ModelRuntime catalogue`);
  }
  return model;
}

export function defaultModel(runtime: ModelRuntime, cfg: AgentConfig): Model<any> {
  return resolveModel(runtime, "ollama", cfg.ollama.model);
}
