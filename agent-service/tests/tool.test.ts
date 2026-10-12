import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { MOCK_MARKER } from "../src/retrieval.ts";
import {
  createSearchTranscriptsTool,
  SEARCH_TRANSCRIPTS_TOOL_NAME,
} from "../src/tools/search-transcripts.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const CTX = {} as ExtensionToolContext;

function baseConfig() {
  const cfg = loadConfig();
  cfg.retrieval.topK = 3;
  cfg.retrieval.timeoutMs = 3000;
  return cfg;
}

test("mock mode returns a clearly-labelled stub", async () => {
  const cfg = baseConfig();
  cfg.retrieval.mock = true;
  const tool = createSearchTranscriptsTool(cfg);

  assert.equal(tool.name, SEARCH_TRANSCRIPTS_TOOL_NAME);
  const result = await tool.execute("call-1", { query: "pricing" }, undefined, undefined, CTX);

  assert.equal(result.isError, undefined);
  assert.equal(result.details.source, "mock");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, new RegExp(MOCK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(result.details.returned, 2);
});

test("calls the configured retrieval endpoint and parses citations", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { query: string; top_k: number };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          query: parsed.query,
          grounded: true,
          max_score: 0.77,
          results: [
            {
              chunk_id: "c1",
              guest: "Ada Cohen",
              episode_title: "Pricing That Works",
              timestamp: "00:12:34",
              source_url: "https://example.com/pricing",
              content: "Anchor on value, not competitors.",
              score: 0.77,
            },
          ],
        }),
      );
    });
  });

  const url = await listen(server);
  try {
    const cfg = baseConfig();
    cfg.retrieval.mock = false;
    cfg.retrieval.url = `${url}/internal/retrieve`;
    const tool = createSearchTranscriptsTool(cfg);

    const result = await tool.execute("call-2", { query: "pricing" }, undefined, undefined, CTX);
    assert.notEqual(result.isError, true);
    assert.equal(result.details.source, "fastapi");
    assert.equal(result.details.grounded, true);
    assert.equal(result.details.returned, 1);
  } finally {
    await close(server);
  }
});

test("unreachable endpoint marks the tool result as an error", async () => {
  const cfg = baseConfig();
  cfg.retrieval.mock = false;
  cfg.retrieval.url = "http://127.0.0.1:1/internal/retrieve";
  cfg.retrieval.timeoutMs = 1500;
  const tool = createSearchTranscriptsTool(cfg);

  const result = await tool.execute("call-3", { query: "pricing" }, undefined, undefined, CTX);
  assert.equal(result.isError, true);
  assert.match(result.details.error ?? "", /unreachable/i);
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
