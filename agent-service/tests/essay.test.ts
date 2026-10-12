import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  buildCorrectivePrompt,
  buildExpansionPrompt,
  runEssayTurn,
  validateEssay,
  wordCount,
  ESSAY_MAX_WORDS,
  ESSAY_MIN_WORDS,
  type EssaySession,
} from "../src/essay.ts";
import type { WireEvent } from "../src/events.ts";

/** Deterministic essay-shaped text with a controllable word total. */
function probe(words: number): string {
  return [
    "Hooks matter because a reader decides quickly whether to keep reading.",
    "## One",
    "**Bold** the pivotal idea here. " + fill(words),
    "## Two",
    "As Ada Cohen said, pricing feels ambiguous without numbers, which is why anchoring matters.",
    "## Actionable takeaway",
    "Do one thing this week: pick a metric and watch it move.",
  ].join("\n\n");
}

function fill(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

test("wordCount counts whitespace-separated tokens", () => {
  assert.equal(wordCount("  hello   world \n foo "), 3);
});

test("validateEssay accepts a well-formed Ship 30 essay", () => {
  const essay = probe(1150);
  const validation = validateEssay(essay);
  assert.equal(validation.pass, true, JSON.stringify(validation.issues));
  assert.ok(
    validation.wordCount >= ESSAY_MIN_WORDS && validation.wordCount <= ESSAY_MAX_WORDS,
    `word count ${validation.wordCount} outside [${ESSAY_MIN_WORDS}, ${ESSAY_MAX_WORDS}]`,
  );
});

test("validateEssay rejects essays outside the word-count band", () => {
  const short = validateEssay(probe(400));
  assert.equal(short.pass, false);
  assert.ok(short.issues.some((issue) => /below.*minimum|minimum.*below/.test(issue)));
  assert.equal(short.issues.length, 1, JSON.stringify(short.issues));

  const long = validateEssay(probe(3000));
  assert.equal(long.pass, false);
  assert.ok(long.issues.some((issue) => /exceeds?.*maximum|maximum.*exceeds/.test(issue)));
});

test("validateEssay flags each missing structure element", () => {
  const heading = validateEssay(probe(1150).replaceAll("## One", "One").replaceAll("## Two", "Two"));
  assert.ok(heading.issues.some((issue) => /headings/.test(issue)));

  const bold = validateEssay(probe(1150).replace("**Bold** the pivotal idea here.", "Bold the pivotal idea here."));
  assert.ok(bold.issues.some((issue) => /\*\*bold\*\*/.test(issue)));

  const takeaway = validateEssay(probe(1150).replace("## Actionable takeaway", "## Closing"));
  assert.ok(takeaway.issues.some((issue) => /takeaway/.test(issue)));

  const attribution = validateEssay(
    probe(1150).replace(
      "As Ada Cohen said, pricing feels ambiguous without numbers, which is why anchoring matters.",
      "Pricing is the most ambiguous part of a SaaS business and founders rarely have numbers.",
    ),
  );
  assert.ok(attribution.issues.some((issue) => /citations/.test(issue)));

  const hook = validateEssay(probe(1150).replace("Hooks matter because a reader decides quickly whether to keep reading.", "Opening."));
  assert.ok(hook.issues.some((issue) => /hook/.test(issue)));
});

test("validateEssay reports empty output", () => {
  const validation = validateEssay("   ");
  assert.equal(validation.pass, false);
  assert.equal(validation.wordCount, 0);
  assert.equal(validation.issues[0], "no essay text produced");
});

test("buildCorrectivePrompt names the failing issues and restates the request", () => {
  const issues = ["include at least two markdown section headings (## ...)", "word count 300 is below the 800-word minimum (target 1250)"];
  const prompt = buildCorrectivePrompt("Turn my notes into an essay", { pass: false, wordCount: 300, issues });
  assert.ok(prompt.includes("include at least two markdown section headings"));
  assert.ok(prompt.includes("word count 300"));
  assert.ok(prompt.includes("Turn my notes into an essay"));
});

// --- runEssayTurn pipeline (deterministic, fake session) ---

interface StubSession {
  session: EssaySession;
  prompts: string[];
  wires: WireEvent[];
}

function stubSession(
  drafts: string[],
  options: { toolOnFirst?: boolean; abortOn?: number } = {},
): StubSession {
  let callNo = 0;
  let listener: ((event: AgentSessionEvent) => void) | null = null;
  const prompts: string[] = [];
  const wires: WireEvent[] = [];

  const session: EssaySession = {
    async prompt(text: string) {
      prompts.push(text);
      callNo += 1;
      if (options.toolOnFirst && callNo === 1) {
        emitToolEvents();
      }
      if (options.abortOn === callNo) {
        listener?.({ type: "agent_settled", aborted: true } as AgentSessionEvent);
        return;
      }
      const draft = drafts[Math.min(callNo - 1, drafts.length - 1)];
      if (draft === undefined) {
        listener?.({ type: "agent_settled", aborted: false } as AgentSessionEvent);
        return;
      }
      for (const chunk of draft.match(/.{1,6}/gs) ?? []) {
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: chunk },
        } as unknown as AgentSessionEvent);
      }
      listener?.({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);
      listener?.({ type: "agent_settled", aborted: false } as AgentSessionEvent);
    },
    subscribe(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };

  function emitToolEvents(): void {
    const payload = {
      query: "pricing",
      grounded: true,
      max_score: 0.72,
      results: [
        {
          chunk_id: "c1",
          guest: "Ada Cohen",
          episode_title: "Pricing That Works",
          timestamp: "00:12:34",
          source_url: "https://example.com/pricing",
          content: "Anchor on value, not competitors.",
          score: 0.72,
        },
      ],
    };
    listener?.({
      type: "tool_execution_start",
      toolName: "search_transcripts",
      args: { query: "pricing" },
    } as unknown as AgentSessionEvent);
    listener?.({
      type: "tool_execution_end",
      toolName: "search_transcripts",
      isError: false,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload },
    } as unknown as AgentSessionEvent);
  }

  return { session, prompts, wires };
}

const WELLFORMED = probe(1150);
const BROKEN = probe(1150).replace("## Actionable takeaway", "## Closing");

test("runEssayTurn streams non-text events live but keeps essay text buffered", async () => {
  const stub = stubSession([WELLFORMED], { toolOnFirst: true });
  const result = await runEssayTurn(stub.session, "Write about pricing", (wire) => stub.wires.push(wire));

  assert.equal(result.retries, 0);
  assert.equal(result.validation.pass, true);
  assert.equal(result.text, WELLFORMED);

  const deltas = stub.wires.filter((wire) => wire.type === "text_delta");
  assert.equal(deltas.length, 0, "essay text must be buffered, not streamed per-delta");
  assert.ok(stub.wires.some((wire) => wire.type === "tool_start"));
  assert.ok(stub.wires.some((wire) => wire.type === "tool_end"));
  const citations = stub.wires.filter((wire): wire is Extract<WireEvent, { type: "citations" }> => wire.type === "citations");
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.citations.length, 1);
  const grounding = stub.wires.filter((wire): wire is Extract<WireEvent, { type: "grounding" }> => wire.type === "grounding");
  assert.equal(grounding.length, 1);
  assert.equal(grounding[0]?.grounded, true);
});

test("runEssayTurn strips a leaked tool call from the draft and retries", async () => {
  const leakyDraft =
    `{"name":"search_transcripts","parameters={"query":"retention moat","top_k":"5"}}` +
    "  \n\n Retention is the real moat.";
  const stub = stubSession([leakyDraft, WELLFORMED]);
  const result = await runEssayTurn(stub.session, "Write about retention", (wire) => stub.wires.push(wire));

  assert.equal(result.text, WELLFORMED, "the leaked JSON must never reach the final essay");
  assert.ok(!result.text.includes('"name":'), `leaked JSON reached the essay text: ${result.text}`);
  assert.equal(result.validation.pass, true);
  assert.equal(result.retries, 1);
  assert.equal(stub.prompts.length, 2);
});

test("runEssayTurn does not retry when the first draft passes", async () => {
  const stub = stubSession([WELLFORMED]);
  const result = await runEssayTurn(stub.session, "Write about pricing", (wire) => stub.wires.push(wire));
  assert.equal(result.retries, 0);
  assert.equal(stub.prompts.length, 1);
  assert.match(stub.prompts[0]!, /Ship 30/);
  assert.match(stub.prompts[0]!, /Write about pricing/);
});

test("runEssayTurn retries once with corrective feedback when the draft fails", async () => {
  const stub = stubSession([BROKEN, WELLFORMED]);
  const result = await runEssayTurn(stub.session, "Write about pricing", (wire) => stub.wires.push(wire));

  assert.equal(result.retries, 1);
  assert.equal(stub.prompts.length, 2);
  assert.equal(result.text, WELLFORMED, "final essay must be the corrected draft");
  assert.equal(result.validation.pass, true);
  assert.match(stub.prompts[1]!, /review/i);
  assert.match(stub.prompts[1]!, /takeaway/);
  assert.match(stub.prompts[1]!, /Write about pricing/);
});

test("runEssayTurn never exceeds one retry even when drafts keep failing", async () => {
  const alsoBroken = BROKEN.replace("**Bold** the pivotal idea here.", "Bold the pivotal idea here.");
  const stub = stubSession([BROKEN, alsoBroken]);
  const result = await runEssayTurn(stub.session, "Write about pricing", () => undefined);

  assert.equal(result.retries, 1);
  assert.equal(stub.prompts.length, 2);
  assert.equal(result.validation.pass, false);
  assert.equal(result.text, alsoBroken, "the last draft is surfaced best-effort");
});

test("runEssayTurn does not retry after an abort", async () => {
  const stub = stubSession([WELLFORMED], { abortOn: 1 });
  const result = await runEssayTurn(stub.session, "Write about pricing", () => undefined);

  assert.equal(result.aborted, true);
  assert.equal(result.retries, 0);
  assert.equal(result.text, "");
  assert.equal(stub.prompts.length, 1);
});

test("buildExpansionPrompt formats draft, current word count, and 1250 target", () => {
  const short = probe(300);
  const prompt = buildExpansionPrompt(short, "Write about pricing", 320);
  assert.match(prompt, /320 words/);
  assert.match(prompt, /1,250 words/);
  assert.match(prompt, /EXPAND/);
  assert.match(prompt, /Ada Cohen/);
});

test("runEssayTurn with a short draft expands to full ~1,250 words", async () => {
  const shortDraft = probe(400);
  const fullDraft = probe(1150);
  const stub = stubSession([shortDraft, fullDraft]);
  const result = await runEssayTurn(stub.session, "Write about pricing", (wire) => stub.wires.push(wire));

  assert.equal(result.retries, 1);
  assert.equal(stub.prompts.length, 2);
  assert.match(stub.prompts[1]!, /EXPAND/);
  assert.match(stub.prompts[1]!, /too short/);
  assert.equal(result.validation.pass, true);
  assert.equal(result.text, fullDraft);
  assert.ok(result.validation.wordCount >= ESSAY_MIN_WORDS && result.validation.wordCount <= ESSAY_MAX_WORDS);
});