import {
  mapAgentEvent,
  readAgentEndInfo,
  type WireEvent,
} from "./events.ts";

export const ARTIFACT_SKILL_NAME = "artifact";

const ARTIFACT_INSTRUCTIONS = `You are generating a standalone artifact.
CRITICAL: DO NOT use any tools. DO NOT output JSON. You must generate the full report content yourself.
Output the main content inside a SINGLE fenced code block (either \`\`\`html or \`\`\`markdown).
Include a brief explanatory message outside the block.
Use an <h1> or # for the title inside the block if appropriate.`;

export function buildArtifactPrompt(userPrompt: string): string {
  return `${ARTIFACT_INSTRUCTIONS}\n\n---\n\n${userPrompt}`;
}

function extractTitle(content: string): string | undefined {
  const h1Match = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    return h1Match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
  const mdMatch = content.match(/^\s*#+\s+(.+)$/m);
  if (mdMatch?.[1]) {
    return mdMatch[1].trim();
  }
  return undefined;
}

export function extractArtifact(text: string): { explanation: string; kind: "html" | "markdown"; content: string; title?: string; hasToolCall: boolean } {
  // Check if text looks like a prompt-based tool call wrapper
  let hasToolCall = false;
  let cleanText = text;
  
  // Clean out common pi-coding-agent hallucinated tool call blocks
  const jsonBlocks = text.match(/```json\n[\s\S]*?\n```/g) || [];
  for (const block of jsonBlocks) {
    if (block.includes('"name"') && (block.includes("write_file") || block.includes("markdown") || block.includes("edit"))) {
      hasToolCall = true;
      cleanText = cleanText.replace(block, "").trim();
    }
  }
  
  // Also check if the raw text itself is just a JSON object
  const trimmed = cleanText.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"name"')) {
    hasToolCall = true;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.name && parsed.parameters) {
        const kind = JSON.stringify(parsed).includes("html") ? "html" : "markdown";
        let content = parsed.parameters.content || parsed.parameters.report || parsed.parameters.html || parsed.parameters.value;
        if (!content && parsed.parameters.file_text) content = parsed.parameters.file_text;
        if (!content) {
          content = "The model attempted to use a tool instead of generating content:\n\n```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
        }
        return { explanation: "I tried to generate the artifact, but output JSON instead.", kind, content, title: extractTitle(content), hasToolCall };
      }
    } catch (e) {
      // Not valid JSON, but looked like a tool call wrapper
      cleanText = "I encountered an error formatting the artifact.";
    }
  }

  const match = cleanText.match(/```(html|markdown)\n([\s\S]*?)\n```/i);
  if (!match || !match[1] || match[2] === undefined) {
    // Fallback if the model just dumps bare HTML
    const fallbackTrimmed = cleanText.trim();
    if (fallbackTrimmed.startsWith("<html") || fallbackTrimmed.startsWith("<!DOCTYPE")) {
      return { explanation: "Here is your requested HTML artifact.", kind: "html", content: fallbackTrimmed, title: extractTitle(fallbackTrimmed), hasToolCall };
    }
    
    // If it's mostly a tool call that failed to parse completely, don't leak it
    if (hasToolCall || fallbackTrimmed.includes('{"name":') || fallbackTrimmed.includes('{"tool":')) {
      return { explanation: "I generated an artifact using internal tools.", kind: "markdown", content: fallbackTrimmed, title: extractTitle(fallbackTrimmed), hasToolCall: true };
    }
    
    return { explanation: cleanText, kind: "markdown", content: cleanText, title: extractTitle(cleanText), hasToolCall };
  }
  
  const kind = match[1].toLowerCase() as "html" | "markdown";
  const content = match[2].trim();
  const explanation = (cleanText.substring(0, match.index) + "\n\n" + cleanText.substring((match.index ?? 0) + match[0].length)).trim();
  return { explanation, kind, content, title: extractTitle(content), hasToolCall };
}

export interface ArtifactSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
}

export async function runArtifactTurn(
  session: ArtifactSession,
  userPrompt: string,
  onWire: (event: WireEvent) => void
): Promise<{ explanation: string; kind: "html" | "markdown"; content: string; title?: string; aborted: boolean; errorMessage?: string }> {
  let buffer = "";
  let abortRequested = false;
  let errorMessage: string | undefined;

  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  
  let toolArtifactKind: "html" | "markdown" | undefined;
  let toolArtifactContent: string | undefined;

  const unsubscribe = session.subscribe((event: any) => {
    // Intercept tool executions in case the model used write_file or markdown tools natively
    if (event.type === "tool_execution_start") {
      const args = event.args || {};
      const content = args.content || args.report || args.value || args.html || args.markdown || args.file_text || args.command;
      if (typeof content === "string" && content.trim().length > 10) {
        toolArtifactKind = JSON.stringify(args).includes("html") ? "html" : "markdown";
        toolArtifactContent = content;
      }
    }
    
    for (const wire of mapAgentEvent(event)) {
      if (wire.type === "text_delta") {
        buffer += wire.text;
      } else if (wire.type === "tool_start" || wire.type === "tool_end") {
        // Suppress these so they don't get handled awkwardly
      } else {
        onWire(wire);
      }
    }
    if (event.type === "agent_end") {
      const info = readAgentEndInfo(event);
      if (info.errorMessage) errorMessage = info.errorMessage;
    }
    if (event.type === "agent_settled") {
      abortRequested = event.aborted;
      settle();
    }
  });

  try {
    await session.prompt(buildArtifactPrompt(userPrompt));
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    await settled;
    unsubscribe();
  }

  // If a tool was executed natively, prefer its content over the text buffer
  if (toolArtifactContent) {
    let explanation = "I generated the artifact.";
    // If the buffer doesn't look like JSON, we can use it as explanation
    if (buffer.trim() && !buffer.includes('{"name":') && !buffer.includes('```json')) {
      explanation = buffer.trim();
    }
    return { explanation, kind: toolArtifactKind || "markdown", content: toolArtifactContent, title: extractTitle(toolArtifactContent), aborted: abortRequested, errorMessage };
  }

  const { explanation, kind, content, title, hasToolCall } = extractArtifact(buffer);
  
  // Do not leak raw json buffer as the explanation if it has tool calls
  let safeExplanation = explanation;
  if (hasToolCall && (explanation.includes('{"name":') || explanation.includes('{"tool":'))) {
    safeExplanation = "I generated the artifact using internal tools.";
  }
  
  return { explanation: safeExplanation, kind, content, title, aborted: abortRequested, errorMessage };
}
