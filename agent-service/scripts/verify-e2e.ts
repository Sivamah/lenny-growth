import assert from "node:assert/strict";

const BASE_URL = "http://127.0.0.1:8000";

interface SseEvent {
  event: string;
  data: any;
}

async function streamChat(sessionId: string, message: string, skill?: string): Promise<SseEvent[]> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      message,
      ...(skill ? { skill } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Chat request failed with HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let eventName = "message";
      let dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
      }

      if (dataStr) {
        try {
          events.push({ event: eventName, data: JSON.parse(dataStr) });
        } catch {
          events.push({ event: eventName, data: dataStr });
        }
      }
    }
  }

  return events;
}

async function runAudit() {
  console.log("=== 1. Health Check ===");
  const healthRes = await fetch(`${BASE_URL}/health`);
  assert.equal(healthRes.status, 200, "Health status should be 200");
  const health = (await healthRes.json()) as any;
  console.log("Health response:", JSON.stringify(health, null, 2));
  assert.equal(health.status, "ok", "Health status should be ok");

  console.log("\n=== 2. Create Session ===");
  const sessRes = await fetch(`${BASE_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Release Audit Test Session" }),
  });
  assert.equal(sessRes.status, 201, "Session creation should be 201");
  const session = (await sessRes.json()) as any;
  console.log("Created session:", session.id, session.title);

  console.log("\n=== 3. Normal Chat Streaming & Grounding ===");
  const chatEvents = await streamChat(
    session.id,
    "What does Lenny's podcast say about PMF?"
  );
  console.log("Chat events received count:", chatEvents.length);
  const eventTypes = chatEvents.map((e) => e.event);
  console.log("Event types seen:", Array.from(new Set(eventTypes)).join(", "));
  assert.ok(eventTypes.includes("turn_start"), "Should have turn_start");
  assert.ok(eventTypes.includes("text_delta"), "Should have text_delta");
  assert.ok(eventTypes.includes("turn_end"), "Should have turn_end");

  let fullChatText = "";
  for (const ev of chatEvents) {
    if (ev.event === "text_delta" && ev.data?.text) {
      fullChatText += ev.data.text;
    }
  }
  console.log("Chat response preview (first 150 chars):", fullChatText.slice(0, 150));
  assert.ok(fullChatText.length > 20, "Should receive non-empty chat prose");

  console.log("\n=== 4. Artifact Generation & Persistence ===");
  const artifactPrompt = "Generate an HTML report on Product-Market Fit Milestones";
  const artifactEvents = await streamChat(session.id, artifactPrompt, "artifact");
  
  let artifactEventData: any = null;
  let artifactExplanation = "";
  for (const ev of artifactEvents) {
    if (ev.event === "text_delta" && ev.data?.text) {
      artifactExplanation += ev.data.text;
    }
    if (ev.event === "artifact") {
      artifactEventData = ev.data;
    }
  }

  console.log("Artifact explanation in chat:", JSON.stringify(artifactExplanation.slice(0, 150)));
  // Verify NO tool calls or JSON leaked into chat prose
  assert.doesNotMatch(artifactExplanation, /"name":\s*"write_file"/, "Raw tool calls must not leak into prose");
  assert.doesNotMatch(artifactExplanation, /"name":\s*"execute_shell"/, "Raw tool calls must not leak into prose");
  
  assert.ok(artifactEventData, "Must receive an artifact event");
  console.log("Artifact event payload:", JSON.stringify(artifactEventData, null, 2));
  assert.ok(artifactEventData.id, "Artifact event must have an id");
  assert.ok(artifactEventData.kind, "Artifact event must have kind (html/markdown)");
  assert.ok(artifactEventData.title, "Artifact event must have title");
  assert.ok(artifactEventData.content, "Artifact event must contain content");

  console.log("\n=== 5. Verify Backend Artifact Persistence ===");
  const getArtRes = await fetch(`${BASE_URL}/artifacts/${artifactEventData.id}`);
  assert.equal(getArtRes.status, 200, "Should retrieve persisted artifact");
  const persistedArt = (await getArtRes.json()) as any;
  console.log("Persisted artifact title:", persistedArt.title);
  console.log("Persisted artifact kind:", persistedArt.kind);
  console.log("Persisted artifact content length:", persistedArt.content.length);
  assert.equal(persistedArt.id, artifactEventData.id);
  assert.equal(persistedArt.session_id, session.id);
  assert.ok(persistedArt.content.length > 50, "Persisted artifact content must be non-empty");

  console.log("\n=== 6. History Persistence & Session Listing ===");
  const msgRes = await fetch(`${BASE_URL}/sessions/${session.id}/messages`);
  assert.equal(msgRes.status, 200);
  const messages = (await msgRes.json()) as any;
  console.log("Session message count in history:", messages.length);
  assert.ok(messages.length >= 4, "Should have at least 2 turns (4 messages)");

  const artsRes = await fetch(`${BASE_URL}/sessions/${session.id}/artifacts`);
  assert.equal(artsRes.status, 200);
  const sessionArts = (await artsRes.json()) as any;
  console.log("Session artifacts listed count:", sessionArts.length);
  assert.ok(sessionArts.length >= 1, "Session artifacts list must contain the generated artifact");

  console.log("\n=== 7. Cleanup Test Session ===");
  const delRes = await fetch(`${BASE_URL}/sessions/${session.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 204, "Delete session should return 204");
  console.log("Cleaned up test session:", session.id);

  console.log("\n>>> ALL LIVE INTEGRATION CHECKS PASSED SUCCESSFULLY! <<<");
}

runAudit().catch((err) => {
  console.error("Audit verification failed:", err);
  process.exit(1);
});
