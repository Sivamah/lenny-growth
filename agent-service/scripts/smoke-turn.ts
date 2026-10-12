import { loadConfig } from "../src/config.ts";
import { startAgentServer } from "../src/server.ts";

interface Line {
  type: string;
  model?: string;
  text?: string;
  name?: string;
  message?: string;
  stop_reason?: string;
  citations?: Array<{ guest?: string; episode?: string }>;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (process.env.RETRIEVAL_MOCK === undefined) {
    cfg.retrieval.mock = true;
  }

  const handle = await startAgentServer(cfg, { port: 0 });
  console.log(`[smoke] service started at ${handle.url} (retrieval.mock=${handle.cfg.retrieval.mock})`);

  try {
    const health = await fetch(`${handle.url}/v1/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
    console.log("[smoke] /v1/health:", JSON.stringify(health));

    const response = await fetch(`${handle.url}/v1/turn`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        ...(cfg.internalToken ? { "X-Internal-Token": cfg.internalToken } : {})
      },
      body: JSON.stringify({
        session_id: `smoke-${Date.now()}`,
        prompt:
          "Use the search_transcripts tool to find what the podcast says about pricing. " +
          "Then answer in one sentence.",
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`turn failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let toolStarts = 0;
    let toolEnds = 0;
    let stopReason: string | undefined;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Line;
        console.log("[ndjson]", line);
        if (event.type === "text_delta") text += event.text ?? "";
        if (event.type === "tool_start") toolStarts += 1;
        if (event.type === "tool_end") toolEnds += 1;
        if (event.type === "turn_end") stopReason = event.stop_reason;
      }
    }

    console.log("\n[smoke] summary");
    console.log("  text length      :", text.length);
    console.log("  text preview     :", JSON.stringify(text.slice(0, 200)));
    console.log("  tool_start count :", toolStarts);
    console.log("  tool_end count   :", toolEnds);
    console.log("  stop_reason      :", stopReason);

    const passed = text.length > 0 && toolStarts > 0 && toolEnds > 0 && stopReason === "stop";
    console.log("[smoke] RESULT:", passed ? "PASS" : "FAIL");
    if (!passed) process.exitCode = 2;
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("[smoke] FATAL:", error);
  process.exit(1);
});
