import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));

export const POC_ROOT = join(here, "..");
export const AGENT_DIR = join(POC_ROOT, "agentdir");
export const MODELS_PATH = join(AGENT_DIR, "models.json");
export const MODELS_BAD_PATH = join(AGENT_DIR, "models-bad.json");
export const AUTH_PATH = join(AGENT_DIR, "auth.json");

export const OLLAMA_PROVIDER = "ollama";
export const OLLAMA_MODEL = "llama3.2:3b";

export async function createRuntime(modelsPath: string = MODELS_PATH): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath,
    authPath: AUTH_PATH,
    allowModelNetwork: false,
  });
}

export function banner(title: string): void {
  console.log("\n============================================================");
  console.log(title);
  console.log("============================================================");
}

export function section(title: string): void {
  console.log("\n--- " + title + " ---");
}
