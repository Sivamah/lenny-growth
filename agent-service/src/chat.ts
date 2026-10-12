import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./config.ts";
import { mapAgentEvent, readAgentEndInfo, type WireEvent } from "./events.ts";
import { retrieve, type RetrievalResult } from "./retrieval.ts";

export const SEARCH_TRANSCRIPTS = "search_transcripts";

const KNOWN_TOOL_NAMES = new Set([SEARCH_TRANSCRIPTS]);

export type PartialClassification =
  | { state: "answer" }
  | { state: "undecided" }
  | { state: "leak"; name: string; parameters: unknown };

/** Index of the brace closing the object that opens at `openIndex`, or -1. */
export function findBalancedClose(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Repair the malformed tool-call key the model emits: `"parameters={query":...}`
 * (no closing quote on the key, `=` instead of `:`) becomes `"parameters":{...}`.
 * Without this the brace scanner never sees the closing quote and JSON.parse
 * fails, so both the streaming classifier and the draft scrubber run on the
 * normalised text.
 */
export function normalizeLeakJson(text: string): string {
  return text.replace(/("parameters)\s*=/g, '$1":');
}

/**
 * Tolerantly parse a tool-call JSON object. Retries the raw parse after
 * normalising the malformed `"parameters"` key described above.
 */
export function parseToolCall(text: string): unknown | undefined {
  const raw = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  return raw(text) ?? raw(normalizeLeakJson(text));
}

/**
 * Decide whether an accumulating chunk of assistant text is a leaked tool call.
 *
 * llama3.2 (and small models generally) sometimes emit a tool call as a bare
 * JSON object in the *text* stream instead of calling the function properly.
 * When they do, no tool executes, no citations are produced, and — if we do
 * nothing — the raw JSON becomes the user-visible answer.
 *
 * A message is classified as a "leak" only when the whole trimmed text parses
 * as one JSON object whose `name` is a tool we recognise and whose `parameters`
 * are present, with nothing but the object on the line. Anything that reads as
 * a real answer (prose, extra text after the object) flushes normally.
 */
export function classifyPartialLeak(text: string): PartialClassification {
  const trimmed = normalizeLeakJson(text.trimStart());
  if (!trimmed.startsWith("{")) return { state: "answer" };

  const closeIndex = findBalancedClose(trimmed, 0);
  if (closeIndex === -1) return { state: "undecided" };

  const after = trimmed.slice(closeIndex + 1).trim();
  if (after.length > 0) return { state: "answer" };

  const candidate = trimmed.slice(0, closeIndex + 1);
  let parsed = parseToolCall(candidate);
  let rawFallback = false;
  if (parsed === undefined && /search_transcripts/.test(candidate)) {
    // A closed object that still does not parse but names our tool and has
    // nothing after it: the model emitted a badly malformed tool call. There is
    // no usable query, so recovery falls back to the original user question.
    parsed = { name: SEARCH_TRANSCRIPTS };
    rawFallback = true;
  }
  if (parsed === undefined) return { state: "undecided" };

  const record = parsed as { name?: unknown; parameters?: unknown };
  if (
    typeof record.name === "string" &&
    KNOWN_TOOL_NAMES.has(record.name) &&
    (record.parameters !== undefined || rawFallback)
  ) {
    return { state: "leak", name: record.name, parameters: record.parameters };
  }
  return { state: "answer" };
}

/** Pull a usable query out of a leaked tool call's parameters. */
export function parseLeakedQuery(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const raw = (parameters as Record<string, unknown>).query;
  if (typeof raw !== "string") return undefined;
  let query = raw.trim();
  // The model sometimes double-quotes the whole query string.
  if (query.length >= 2 && query.startsWith('"') && query.endsWith('"')) {
    query = query.slice(1, -1).trim() || query;
  }
  return query.length > 0 ? query.slice(0, 500) : undefined;
}

/**
 * Remove embedded tool-call JSON objects from text (used by buffered skill
 * paths like Ship 30 essays, where the draft is validated after the fact so
 * we can afford to delete leaks in place). Non-tool JSON blocks are preserved.
 */
export function stripToolCallLeaks(text: string): string {
  const normalized = normalizeLeakJson(text);
  let out = "";
  let i = 0;
  while (i < normalized.length) {
    const open = normalized.indexOf("{", i);
    if (open === -1) {
      out += normalized.slice(i);
      break;
    }
    const close = findBalancedClose(normalized, open);
    if (close === -1) {
      out += normalized.slice(i);
      break;
    }
    const candidate = normalized.slice(open, close + 1);
    if (classifyPartialLeak(candidate).state === "leak") {
      out += normalized.slice(i, open);
      let j = close + 1;
      for (; j < normalized.length && /\s/.test(normalized[j] ?? ""); j++) {
        // skip the whitespace that separated the leaked object from prose
      }
      i = j;
    } else {
      out += normalized.slice(i, open + 1);
      i = open + 1;
    }
  }
  return out.trim();
}

export function buildRecoveryPrompt(
  userPrompt: string,
  evidence: RetrievalResult | null,
): string {
  if (!evidence) {
    return `Answer the user's question directly and helpfully. Do not output a JSON tool call as your answer.\n\nUser question: ${userPrompt}`;
  }
  if (!evidence.grounded) {
    return `The search over Lenny's podcast transcript library returned no confident matches (max_score=${evidence.max_score.toFixed(3)}, below the grounding threshold).

Rules:
- State clearly and honestly that the podcast transcript library does not cover this topic or contain evidence for this question.
- Do NOT invent guests, episodes, quotes, or citations.
- If appropriate, provide a brief, helpful answer using general knowledge while clearly noting that this is from general knowledge, not from Lenny's podcast transcripts.
- Be concise, use markdown, and do NOT output a JSON tool call as your answer.

User question: ${userPrompt}`;
  }
  const grounded = `max_score=${evidence.max_score.toFixed(3)}`;
  return `Answer the user's question using ONLY the transcript evidence below. It was already retrieved, so do NOT call search_transcripts again.

Transcript evidence (${grounded}):
${JSON.stringify(evidence)}

Rules:
- Ground the answer in this evidence only: name the episode and guest for every substantive claim.
- If the evidence answers only part of the question, answer that part and say the rest is not covered.
- Be concise, use markdown, and do NOT output a JSON tool call as your answer.

User question: ${userPrompt}`;
}

function buildEvidenceFallback(evidence: RetrievalResult): string {
  if (!evidence.grounded || evidence.results.length === 0) {
    return "The transcript library does not clearly cover this topic, so I couldn't ground a full answer. Try a different framing and I'll search again.";
  }
  const bullets = evidence.results
    .slice(0, 3)
    .map((chunk) => {
      const source = [chunk.episode_title, chunk.guest].filter(Boolean).join(" with ");
      return `- ${source}: ${chunk.content.slice(0, 240)}${
        chunk.score !== undefined ? ` (score ${chunk.score.toFixed(2)})` : ""
      }`;
    })
    .join("\n");
  return `Based on the transcript evidence:\n\n${bullets}\n\n(The assistant's text stream was malformed, so this summary is shown instead.)`;
}

/** Minimal session surface the chat guard needs (real AgentSession satisfies it). */
export interface ChatSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface ChatTurnResult {
  text: string;
  aborted: boolean;
  errorMessage?: string;
  /** True when the first pass leaked a tool call and a corrective pass ran. */
  recovered: boolean;
}

/**
 * Run one normal chat turn with a leaked-tool-call guard.
 *
 * Text deltas stream live, EXCEPT while the buffered prefix could be a leaked
 * JSON tool call. If the whole turn resolves to a leaked tool call it is never
 * emitted; instead we run the tool ourselves, stream its citations/grounding,
 * and re-drive the model once with the evidence to recover the final answer.
 */
import {
  extractConstraints,
  buildConstraintEnforcementPrompt,
  validateResponseAgainstConstraints,
  buildCorrectivePrompt,
} from "./constraints.ts";

/**
 * Run one normal chat turn with a leaked-tool-call guard and constraint validation.
 *
 * Text deltas stream live for unconstrained turns. For constrained planning/budget/limit
 * queries, the draft is validated against constraints before emission; if constraints
 * are violated, a single corrective pass recovers a compliant answer before streaming.
 */
export async function runChatTurn(
  cfg: AgentConfig,
  session: ChatSession,
  userPrompt: string,
  onWire: (event: WireEvent) => void,
): Promise<ChatTurnResult> {
  const constraints = extractConstraints(userPrompt);
  const promptToRun = buildConstraintEnforcementPrompt(userPrompt, constraints);
  const shouldBuffer = constraints.hasConstraints;

  let abortRequested = false;
  let errorMessage: string | undefined;

  let pending = "";
  let leak: { name: string; parameters: unknown } | undefined;
  let answerText = "";
  let bufferedDraft = "";

  let settle!: () => void;
  let settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const emit = (text: string): void => {
    if (text.length > 0) {
      if (shouldBuffer) {
        bufferedDraft += text;
      } else {
        onWire({ type: "text_delta", text });
        answerText += text;
      }
    }
  };

  const flush = (): void => {
    if (pending.length > 0) {
      emit(pending);
      pending = "";
    }
  };

  const unsubscribe = session.subscribe((event) => {
    for (const wire of mapAgentEvent(event)) {
      if (wire.type === "text_delta") {
        pending += wire.text;
        const classification = classifyPartialLeak(pending);
        if (classification.state === "answer") {
          leak = undefined;
          flush();
        } else if (classification.state === "leak") {
          leak = { name: classification.name, parameters: classification.parameters };
        }
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

  const runPass = async (
    prompt: string,
    resolveLeak: (leaked: boolean) => void,
  ): Promise<void> => {
    pending = "";
    leak = undefined;
    settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      await session.prompt(prompt);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    try {
      await settled;
    } catch {
      // settled only resolves in the subscribe listener; never rejects
    }
    resolveLeak(classifyPartialLeak(pending).state === "leak");
    pending = "";
  };

  try {
    let recovered = false;

    await runPass(promptToRun, () => {
      // If classification stayed undecided at turn end (e.g. trailing text), flush it
      if (pending.length > 0 && !leak) {
        flush();
      }
    });

    // A confirmed leak means the model never called the tool and never wrote an
    // answer. Recover: execute the tool ourselves, stream its evidence, then
    // re-drive the model once with that evidence.
    if (leak && !abortRequested && !errorMessage) {
      const query = parseLeakedQuery(leak.parameters) ?? userPrompt;
      let evidence: RetrievalResult | null = null;
      try {
        const started = Date.now();
        onWire({ type: "tool_start", name: SEARCH_TRANSCRIPTS, args: { query, top_k: cfg.retrieval.topK } });
        evidence = await retrieve(cfg, query, cfg.retrieval.topK);
        const citations = evidence.results
          .filter((chunk) => chunk.episode_title || chunk.guest || chunk.source_url)
          .map((chunk) => ({
            guest: chunk.guest,
            episode: chunk.episode_title,
            timestamp: chunk.timestamp,
            url: chunk.source_url,
            snippet: chunk.content.slice(0, 280),
            score: chunk.score,
          }));
        if ((evidence.grounded || evidence.source === "mock") && citations.length > 0) {
          onWire({ type: "citations", citations });
        }
        onWire({ type: "grounding", grounded: evidence.grounded, maxScore: evidence.max_score });
        onWire({ type: "tool_end", name: SEARCH_TRANSCRIPTS, isError: false, durationMs: Date.now() - started });
      } catch (error) {
        onWire({ type: "tool_end", name: SEARCH_TRANSCRIPTS, isError: true, durationMs: 0 });
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      if (evidence && !abortRequested) {
        recovered = true;
        await runPass(buildRecoveryPrompt(userPrompt, evidence), (leaked) => {
          if (leaked) {
            emit(buildEvidenceFallback(evidence));
          }
        });
      }
    }

    // Constraint Validation & Single Corrective Pass (when constraints are active)
    if (shouldBuffer && !abortRequested && !errorMessage && !leak) {
      const validation = validateResponseAgainstConstraints(bufferedDraft, constraints);
      if (validation.pass) {
        onWire({ type: "text_delta", text: bufferedDraft });
        answerText = bufferedDraft;
      } else {
        // Draft violated hard constraints: execute a single corrective pass
        recovered = true;
        const correctivePrompt = buildCorrectivePrompt(userPrompt, validation.issues, constraints);
        bufferedDraft = "";
        await runPass(correctivePrompt, () => {
          if (pending.length > 0 && !leak) {
            flush();
          }
        });
        onWire({ type: "text_delta", text: bufferedDraft });
        answerText = bufferedDraft;
      }
    }

    return { text: answerText, aborted: abortRequested, errorMessage, recovered };
  } finally {
    unsubscribe();
  }
}