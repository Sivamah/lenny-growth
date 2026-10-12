import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createAgentRuntime } from "../src/runtime.ts";
import { SessionPool } from "../src/session-pool.ts";
import { mapAgentEvent } from "../src/events.ts";

async function ollamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

// Runs a genuine local Ollama turn through the SDK. Skips (does not fail) when
// Ollama is not running, so the suite stays portable.
test(
  "real ollama turn streams text and invokes search_transcripts",
  { timeout: 180000 },
  async (t) => {
    const cfg = loadConfig();
    cfg.retrieval.mock = true;

    if (!(await ollamaReachable(cfg.ollama.nativeBaseUrl))) {
      t.skip(`Ollama not reachable at ${cfg.ollama.nativeBaseUrl}`);
      return;
    }

    const agentRuntime = await createAgentRuntime(cfg);
    const pool = new SessionPool(cfg, agentRuntime.runtime);

    try {
      const live = await pool.ensure("test-ollama-session");

      let text = "";
      let toolStarts = 0;
      let toolEnds = 0;
      let settled = false;
      let aborted = false;

      const unsubscribe = live.session.subscribe((event) => {
        for (const wire of mapAgentEvent(event)) {
          if (wire.type === "text_delta") text += wire.text;
          if (wire.type === "tool_start") toolStarts += 1;
          if (wire.type === "tool_end") toolEnds += 1;
        }
        if (event.type === "agent_settled") {
          settled = true;
          aborted = event.aborted;
        }
      });

      try {
        await live.session.prompt(
          'Use the search_transcripts tool with the query "pricing". Then reply with one short sentence.',
        );
      } finally {
        unsubscribe();
      }

      assert.ok(text.length > 0, "expected assistant text to be streamed");
      assert.ok(toolStarts > 0, "expected a search_transcripts tool call");
      assert.ok(toolEnds > 0, "expected a search_transcripts tool result");
      assert.equal(aborted, false);
      assert.equal(settled, true);
    } finally {
      pool.disposeAll();
    }
  },
);
