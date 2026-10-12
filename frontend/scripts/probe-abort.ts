import { api } from "../src/api/client";
import { streamChat } from "../src/api/sse";
import type { ChatEvent } from "../src/types";

async function main(): Promise<void> {
  const session = await api.createSession();
  console.log("session", session.id);
  const controller = new AbortController();
  let deltas = 0;
  let caught: unknown = null;
  try {
    await streamChat(session.id, "Explain in detail what mistake 99% of founders and sales reps make and how to avoid it.", {
      signal: controller.signal,
      onEvent: (e: ChatEvent) => {
        if (e.type === "text_delta") {
          deltas++;
          if (deltas === 1) controller.abort();
        }
      },
    });
  } catch (err) {
    caught = err;
  }
  console.log("deltas before abort:", deltas, "| caught:", caught instanceof Error ? caught.name : caught);
  for (let i = 0; i < 10; i++) {
    const msgs = await api.getMessages(session.id);
    const roles = msgs.map((m) => `${m.role}:${m.content ? m.content.length : 0}`);
    console.log(`poll ${i + 1}: ${roles.join(" | ")}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process?.exit(0);
}

main().catch((e) => {
  console.error(e);
  process?.exit(2);
});