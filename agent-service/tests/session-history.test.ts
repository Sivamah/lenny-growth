import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { seedHistory, type HistoryMessage } from "../src/session-pool.ts";

function fakeModel(): Model<any> {
  return {
    id: "llama3.2:3b",
    name: "llama3.2:3b",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    input: ["text"],
    cost: { input: 0, output: 0 },
  } as unknown as Model<any>;
}

function projected(manager: SessionManager): Array<{ role: string; text: string }> {
  const context = manager.buildSessionProjection();
  return context.messages
    .flatMap((message) => {
      const role = (message as { role?: string }).role ?? "?";
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [{ role, text: content }];
      if (Array.isArray(content)) {
        return content
          .filter(
            (block): block is { type: "text"; text: string } =>
              Boolean(block) &&
              typeof block === "object" &&
              (block as { type?: unknown }).type === "text",
          )
          .map((block) => ({ role, text: block.text }));
      }
      return [];
    });
}

test("seedHistory with no frames leaves an empty session context", () => {
  const manager = SessionManager.inMemory();
  seedHistory(manager, [], fakeModel());
  assert.deepEqual(manager.buildSessionProjection().messages, []);
});

test("seeded user and assistant frames appear in the model-visible projection in order", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "What is retention like?" },
    { role: "assistant", content: "Early users drop fast." },
    { role: "user", content: "And activation?" },
  ];
  const manager = SessionManager.inMemory();
  seedHistory(manager, history, fakeModel());

  const projection = projected(manager);
  assert.deepEqual(projection, [
    { role: "user", text: "What is retention like?" },
    { role: "assistant", text: "Early users drop fast." },
    { role: "user", text: "And activation?" },
  ]);
});

test("seeded entries are registered as a real conversation (getEntries sees them)", () => {
  const manager = SessionManager.inMemory();
  seedHistory(
    manager,
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    fakeModel(),
  );
  const entries = manager.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.type, "message");
  assert.equal(entries[1]?.type, "message");
});