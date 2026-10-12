import assert from "node:assert/strict";
import { api } from "../src/api/client";
import { streamChat } from "../src/api/sse";
import type { ChatEvent } from "../src/types";

async function main() {
  console.log("=== STARTING LIVE ARTIFACT & REGRESSION VERIFICATION ===");

  // 1. Health check
  const health = await api.health();
  assert.equal(health.status, "ok", "Backend health should be ok");
  console.log("[PASS] Backend health: ok, dependencies reachable");

  // 2. Create Session
  const session = await api.createSession("Artifact & Regression Verification");
  console.log(`[PASS] Created test session: ${session.id}`);

  // 3. Test B: Real Artifact Generation
  console.log("\n--- TEST B: Real Artifact Generation ---");
  const artifactPrompt = "Create a standalone HTML comparison card for B2B vs B2C churn benchmarks.";
  const artifactEvents: ChatEvent[] = [];
  let artifactText = "";
  let receivedArtifact: any = null;

  await streamChat(session.id, artifactPrompt, {
    signal: new AbortController().signal,
    skill: "artifact",
    onEvent: (event: ChatEvent) => {
      artifactEvents.push(event);
      if (event.type === "text_delta") {
        artifactText += event.data.text;
      } else if (event.type === "artifact") {
        receivedArtifact = event.data;
      }
    },
  });

  // Verify chat prose has NO leaked tool calls
  console.log(`Chat text preview: ${JSON.stringify(artifactText.slice(0, 120))}`);
  assert.doesNotMatch(artifactText, /"name":\s*"write_file"/, "Prose must not contain raw write_file tool call JSON");
  assert.doesNotMatch(artifactText, /"name":\s*"execute_shell"/, "Prose must not contain raw execute_shell tool call JSON");
  assert.doesNotMatch(artifactText, /@earendil-works\/pi-coding-agent/, "Prose must not contain internal SDK filesystem paths");
  console.log("[PASS] Chat prose is clean of raw tool calls and system paths");

  // Verify artifact event
  assert.ok(receivedArtifact, "Must receive an artifact event");
  assert.ok(receivedArtifact.id, "Artifact must have an ID");
  assert.ok(receivedArtifact.kind === "html" || receivedArtifact.kind === "markdown", "Artifact kind must be html or markdown");
  assert.ok(receivedArtifact.title && receivedArtifact.title.length > 0, "Artifact must have a non-empty title");
  assert.ok(receivedArtifact.content && receivedArtifact.content.length > 50, "Artifact must have non-empty content");
  console.log(`[PASS] Artifact event valid: id=${receivedArtifact.id}, kind=${receivedArtifact.kind}, title="${receivedArtifact.title}", content_len=${receivedArtifact.content.length}`);

  // Verify backend persistence via GET /artifacts/{id}
  const persisted = await api.getArtifact(receivedArtifact.id);
  assert.equal(persisted.id, receivedArtifact.id, "Persisted ID must match event ID");
  assert.equal(persisted.session_id, session.id, "Persisted session_id must match current session");
  assert.ok(persisted.content.length > 50, "Persisted content must be stored in database");
  console.log(`[PASS] Backend persistence verified in PostgreSQL: stored ${persisted.content.length} characters`);

  // Verify session artifacts listing
  const sessionArts = await api.listArtifacts(session.id);
  assert.ok(sessionArts.some((a) => a.id === receivedArtifact.id), "Session artifacts list must contain the generated artifact");
  console.log(`[PASS] Session artifacts listing contains artifact`);

  // 4. Test C: Regression - Ship 30 Essay Generation
  console.log("\n--- TEST C1: Ship 30 Essay Generation ---");
  const essayPrompt = "Turn our discussion about churn into a Ship 30 for 30 essay.";
  let essayText = "";
  const essayEvents: ChatEvent[] = [];

  await streamChat(session.id, essayPrompt, {
    signal: new AbortController().signal,
    skill: "ship30_essay",
    onEvent: (event: ChatEvent) => {
      essayEvents.push(event);
      if (event.type === "text_delta") {
        essayText += event.data.text;
      }
    },
  });

  assert.ok(essayText.length > 200, "Ship 30 essay should produce substantial essay content");
  console.log(`[PASS] Ship 30 essay generated: ${essayText.length} characters`);

  // 5. Test C2: Session Switching & History Restoration
  console.log("\n--- TEST C2: Session Switching & History Restoration ---");
  const session2 = await api.createSession("Isolated Session 2");
  const messages2 = await api.getMessages(session2.id);
  assert.equal(messages2.length, 0, "New session must be empty");

  // Reload history of first session
  const messages1 = await api.getMessages(session.id);
  assert.ok(messages1.length >= 4, `Original session must retain history (found ${messages1.length} messages)`);
  console.log(`[PASS] Session switching & history restoration verified: session 1 has ${messages1.length} messages, session 2 has 0 messages`);

  // 6. Cleanup
  await api.deleteSession(session.id);
  await api.deleteSession(session2.id);
  console.log("[PASS] Cleanup completed");

  console.log("\n>>> ALL TESTS IN VERIFICATION SUITE PASSED SUCCESSFULLY! <<<");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process?.exit(1);
});
