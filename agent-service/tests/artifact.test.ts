import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildArtifactPrompt,
  extractArtifact,
  runArtifactTurn,
  type ArtifactSession,
} from "../src/artifact.ts";
import type { WireEvent } from "../src/events.ts";

describe("artifact pipeline", () => {
  it("builds artifact prompt containing critical rules and user prompt", () => {
    const prompt = buildArtifactPrompt("Create a landing page analysis");
    assert.match(prompt, /Create a landing page analysis/);
    assert.match(prompt, /DO NOT use any tools/);
    assert.match(prompt, /SINGLE fenced code block/);
  });

  it("extracts markdown artifact and derives title from # heading", () => {
    const raw = `Here is the document you requested.\n\n\`\`\`markdown\n# Lenny's Growth Framework\n\nThis framework focuses on retention and activation.\n\`\`\`\n\nHope this helps!`;
    const result = extractArtifact(raw);

    assert.equal(result.kind, "markdown");
    assert.equal(result.title, "Lenny's Growth Framework");
    assert.match(result.content, /# Lenny's Growth Framework/);
    assert.match(result.explanation, /Here is the document/);
    assert.match(result.explanation, /Hope this helps!/);
    assert.equal(result.hasToolCall, false);
  });

  it("extracts html artifact and derives title from <h1> heading", () => {
    const raw = `I created an interactive widget for you.\n\n\`\`\`html\n<div class="card">\n  <h1>Cohort Retention Dashboard</h1>\n  <p>Metrics for Q1-Q4.</p>\n</div>\n\`\`\``;
    const result = extractArtifact(raw);

    assert.equal(result.kind, "html");
    assert.equal(result.title, "Cohort Retention Dashboard");
    assert.match(result.content, /Cohort Retention Dashboard/);
    assert.equal(result.hasToolCall, false);
  });

  it("extracts html artifact with B2B vs B2C Churn Benchmarks heading and attributes", () => {
    const raw = `Here is your requested benchmark analysis.\n\n\`\`\`html\n<article class="benchmark-view">\n  <h1 class="font-bold text-xl">\n    B2B vs B2C Churn Benchmarks\n  </h1>\n  <p>Comparative metrics table.</p>\n</article>\n\`\`\``;
    const result = extractArtifact(raw);

    assert.equal(result.kind, "html");
    assert.equal(result.title, "B2B vs B2C Churn Benchmarks");
    assert.match(result.content, /B2B vs B2C Churn Benchmarks/);
    assert.equal(result.hasToolCall, false);
  });


  it("safely handles raw JSON tool call blocks without leaking JSON to assistant prose", () => {
    const raw = `\`\`\`json\n{\n  "name": "write_file",\n  "parameters": {\n    "content": "# Churn Analysis\\n\\nDetailed churn report."\n  }\n}\n\`\`\``;
    const result = extractArtifact(raw);

    assert.equal(result.hasToolCall, true);
    // Prose must not leak raw tool call code
    assert.doesNotMatch(result.explanation, /"name":\s*"write_file"/);
  });

  it("safely intercepts native tool_execution_start in runArtifactTurn", async () => {
    let capturedWire: WireEvent[] = [];
    const mockSession: ArtifactSession = {
      async prompt(_text: string) {},
      subscribe(listener: (event: any) => void) {
        // Emit tool_execution_start with an artifact report
        setTimeout(() => {
          listener({
            type: "tool_execution_start",
            args: {
              report: "# Retention Guide\n\nStep 1: Onboarding improvements.",
            },
          });
          listener({
            type: "text_delta",
            text: "I generated the artifact using my analysis.",
          });
          listener({
            type: "agent_settled",
            aborted: false,
          });
        }, 10);
        return () => {};
      },
    };

    const res = await runArtifactTurn(
      mockSession,
      "Generate a retention guide artifact",
      (wire) => capturedWire.push(wire),
    );

    assert.equal(res.kind, "markdown");
    assert.equal(res.title, "Retention Guide");
    assert.match(res.content, /Step 1: Onboarding improvements/);
    assert.doesNotMatch(res.explanation, /\{"name"/);
    assert.equal(res.aborted, false);
  });

  it("builds website artifact prompt with responsive guidelines and sections", () => {
    const prompt = buildArtifactPrompt("Create a responsive landing page for an AI startup");
    assert.match(prompt, /complete, polished, self-contained HTML\/CSS website/);
    assert.match(prompt, /embedded <style> block/);
    assert.match(prompt, /Navigation bar/);
    assert.match(prompt, /Hero section/);
    assert.match(prompt, /Pricing plans/);
  });

  it("extracts complete HTML website with embedded style and nav/hero sections", () => {
    const raw = `Here is your website landing page.\n\n\`\`\`html\n<!DOCTYPE html>\n<html>\n<head>\n  <title>NexusAI - Intelligent Productivity</title>\n  <style>\n    body { font-family: sans-serif; margin: 0; background: #0f172a; }\n    .hero { display: flex; flex-direction: column; align-items: center; padding: 4rem 2rem; }\n  </style>\n</head>\n<body>\n  <nav class="nav"><h1>NexusAI</h1></nav>\n  <section class="hero"><h2>Supercharge Your Workflow</h2></section>\n</body>\n</html>\n\`\`\`\n\nEnjoy!`;
    const result = extractArtifact(raw);

    assert.equal(result.kind, "html");
    assert.equal(result.title, "NexusAI - Intelligent Productivity");
    assert.match(result.content, /<style>/);
    assert.match(result.content, /display: flex/);
    assert.match(result.content, /NexusAI/);
    assert.match(result.explanation, /Here is your website landing page/);
  });
});
