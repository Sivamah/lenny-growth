import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { stripToolCallLeaks } from "./chat.ts";
import {
  mapAgentEvent,
  readAgentEndInfo,
  type WireEvent,
} from "./events.ts";

export const SHIP30_ESSAY_SKILL_NAME = "ship30_essay";

export const ESSAY_TARGET_WORDS = 1250;
export const ESSAY_MIN_WORDS = 800;
export const ESSAY_MAX_WORDS = 2200;
export const ESSAY_MAX_RETRIES = 1;

/**
 * The skill prompt is a strict, ready-to-follow brief. It is prefixed to the
 * user's request so the instructions are always the first thing the model
 * sees. The grounding/citation rule mirrors the search_transcripts tool
 * guidelines: when `grounded` is false the essay must say so instead of
 * fabricating facts.
 */
const ESSAY_INSTRUCTIONS = `You are writing a "Ship 30 for 30" style essay of roughly 1,250 words.

Meet every requirement below:
1. OPEN with a hook: 1-2 sentences that grab the reader, then set up the core tension of the essay.
2. Organise the body with markdown ## SECTION HEADINGS (at least two sections) that carry a narrative from opener to payoff.
3. Emphasise key phrases with **bold** (a bolded thesis statement is a good idea).
4. Ground every substantive claim in the search_transcripts tool results: name the episode and the guest, and quote or closely paraphrase the returned chunk. Attribute ideas explicitly (for example: "In Lenny's Podcast episode with <guest>, they point out that ...").
5. END with an "Actionable takeaway" section that gives the reader one concrete thing to do this week, based on the source material.
6. If search_transcripts reports grounded=false (the transcripts do not cover the topic), say so plainly in the essay and do not invent guests, quotes, episodes, or facts.
7. Aim for ~1,250 words. Output ONLY the finished essay markdown - no preamble, no "here is", no summary afterwards.`;

export function buildEssayPrompt(userPrompt: string): string {
  return `${ESSAY_INSTRUCTIONS}\n\n---\n\n${userPrompt}`;
}

export function buildCorrectivePrompt(
  userPrompt: string,
  validation: EssayValidation,
): string {
  const bullet = validation.issues.map((issue) => `- ${issue}`).join("\n");
  return `A "Ship 30" essay review found the following issues in your previous draft:

${bullet}

Rewrite the essay from scratch so every issue is fixed. Keep it grounded in the search_transcripts results (name the episode and guest, attribute each claim), aim for ~1,250 words, and output ONLY the finished markdown essay with a hook, at least two ## headings, **bold** emphasis, and a closing "Actionable takeaway" section.

Original request: ${userPrompt}`;
}

export interface EssayValidation {
  pass: boolean;
  wordCount: number;
  issues: string[];
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Structural Ship 30 review. Kept deliberately deterministic so the skill can
 * retry with corrective feedback and tests can assert exact boundary behaviour.
 * Targets ~1,250 words; accepts a band that the local 3B model can still hit.
 */
export function validateEssay(text: string): EssayValidation {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { pass: false, wordCount: 0, issues: ["no essay text produced"] };
  }

  const count = wordCount(trimmed);
  const issues: string[] = [];

  if (count < ESSAY_MIN_WORDS) {
    issues.push(
      `word count ${count} is below the ${ESSAY_MIN_WORDS}-word minimum (target ${ESSAY_TARGET_WORDS})`,
    );
  }
  if (count > ESSAY_MAX_WORDS) {
    issues.push(
      `word count ${count} exceeds the ${ESSAY_MAX_WORDS}-word maximum (target ${ESSAY_TARGET_WORDS})`,
    );
  }

  const headings = trimmed.match(/^#{1,6}\s+\S[^\n]*$/gm) ?? [];
  if (headings.length < 2) {
    issues.push("include at least two markdown section headings (## ...)");
  }

  if (!/\*\*[^*\n]+\*\*/.test(trimmed)) {
    issues.push("include at least one **bold** emphasis");
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs[0] !== undefined && wordCount(paragraphs[0]) < 8) {
    issues.push("open with an engaging hook paragraph (at least 8 words)");
  }

  if (!/\b(takeaway|actionable|what to do|next step|three things)\b/i.test(trimmed)) {
    issues.push('end with an "Actionable takeaway" section');
  }

  if (
    !/\b(says?|said|explains?|explained|argues?|argued|observes?|observed|notes?|noted|recommends?|recommended|points out|according to|told|advises?|advised|warns?|warned)\b|\b(episode|guest)\b/i.test(
      trimmed,
    )
  ) {
    issues.push(
      "ground substantive claims with citations (name the episode and the guest from the transcripts)",
    );
  }

  return { pass: issues.length === 0, wordCount: count, issues };
}

/** Minimal session surface the essay skill needs (real AgentSession satisfies it). */
export interface EssaySession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface EssayTurnResult {
  text: string;
  validation: EssayValidation;
  retries: number;
  aborted: boolean;
  errorMessage?: string;
}

/**
 * Run a Ship 30 essay turn.
 *
 * Assistant text is buffered per-pass so a corrective retry can replace a
 * failed draft (the persisted essay is the final, reviewed version) instead of
 * leaving both drafts in the transcript. Non-text wire events (tool calls,
 * citations, grounding, usage) are streamed live via `onWire`.
 *
 * At most one corrective retry is issued; the retry prompt names the exact
 * validation failures.
 */
export async function runEssayTurn(
  session: EssaySession,
  userPrompt: string,
  onWire: (event: WireEvent) => void,
  options: { maxRetries?: number } = {},
): Promise<EssayTurnResult> {
  const maxRetries = options.maxRetries ?? ESSAY_MAX_RETRIES;

  let buffer = "";
  let abortRequested = false;
  let errorMessage: string | undefined;
  let willRetry = false;

  let settle!: () => void;
  let settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const unsubscribe = session.subscribe((event) => {
    for (const wire of mapAgentEvent(event)) {
      if (wire.type === "text_delta") buffer += wire.text;
      else onWire(wire);
    }
    if (event.type === "agent_end") {
      const info = readAgentEndInfo(event);
      if (info.errorMessage) errorMessage = info.errorMessage;
      if (info.willRetry) willRetry = true;
    }
    if (event.type === "auto_retry_end" && !event.success) {
      if (event.finalError) errorMessage = event.finalError;
      willRetry = true;
    }
    if (event.type === "agent_settled") {
      abortRequested = event.aborted;
      settle();
    }
  });

  async function runPass(text: string): Promise<string> {
    buffer = "";
    settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      await session.prompt(text);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      willRetry = true;
    }
    await settled;
    return stripToolCallLeaks(buffer);
  }

  try {
    let retries = 0;
    let draft = await runPass(buildEssayPrompt(userPrompt));
    let validation = validateEssay(draft);

    if (!validation.pass && !abortRequested && !errorMessage && !willRetry && retries < maxRetries) {
      retries += 1;
      draft = await runPass(buildCorrectivePrompt(userPrompt, validation));
      validation = validateEssay(draft);
    }

    return { text: draft, validation, retries, aborted: abortRequested, errorMessage };
  } finally {
    unsubscribe();
  }
}