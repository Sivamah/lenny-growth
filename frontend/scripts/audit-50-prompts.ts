/**
 * Independent 50-prompt QA benchmark for the live Lenny Growth Assistant stack.
 *
 * Talks only to the real services:
 *   - FastAPI backend (default http://127.0.0.1:8000)
 *   - which talks to the Node agent-service (Ollama llama3.2:3b) and PostgreSQL
 *
 * Every prompt runs against a freshly created session, verifies the observed
 * stream + persisted state, then cleans up the session it created. Results are
 * appended to a JSON file (target: <project-root>/DEEPSEEK_50_PROMPT_RESULTS.json)
 * so a timeout never loses completed prompts.
 *
 * Usage (from frontend/):
 *   npx tsx scripts/audit-50-prompts.ts [--category in,out,history,...] [--limit N]
 */
import { resolve, join, dirname } from "node:path";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SseBufferParser, parseSseFrame } from "../src/api/sse";
import type { ChatEvent } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const RESULTS_PATH = process.env.AUDIT_RESULTS ?? join(PROJECT_ROOT, "docs", "reports", "DEEPSEEK_50_PROMPT_RESULTS.json");

const BASE = process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:8000";
const SESSION_TITLE_PREFIX = "AUDIT-50:";
const PROMPT_TIMEOUT_MS = Number(process.env.AUDIT_PROMPT_TIMEOUT_MS ?? 300_000);

interface StreamSummary {
  stopReason: string;
  grounded: boolean | null;
  messageId: string | null;
  model: string | null;
  provider: string | null;
  errorMessage: string | null;
  retryable: boolean;
}

interface TurnResult {
  events: ChatEvent[];
  text: string;
  citations: Array<Record<string, unknown>>;
  usage: Record<string, unknown> | null;
  artifact: ChatEvent & { __kind_guard?: never } | null;
  summary: StreamSummary;
  durationMs: number;
}

interface ApiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider: string | null;
  skill: string | null;
  citations: Array<Record<string, unknown>>;
  model: string | null;
  grounding: { grounded: boolean; max_score: number | null } | null;
  token_usage: Record<string, unknown> | null;
  created_at: string;
}

interface ApiSession {
  id: string;
  title: string | null;
}

interface ArtifactSummary {
  id: string;
  session_id: string;
  message_id: string | null;
  kind: "html" | "markdown";
  title: string | null;
  created_at: string;
}

interface ArtifactRead extends ArtifactSummary {
  content: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: T = undefined as T;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = text as unknown as T;
    }
  }
  return { status: res.status, body };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 12_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await wait(350);
  }
  return false;
}

function randomUuid(): string {
  return "00000000-0000-4000-8000-" + Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function hasAbortName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) return String((err as { name?: unknown }).name);
  return String(err);
}

async function createSession(label?: string): Promise<ApiSession> {
  const { status, body } = await request<ApiSession>("/sessions", {
    method: "POST",
    body: JSON.stringify(label ? { title: label } : {}),
  });
  if (status !== 201 || !body || typeof (body as { id?: unknown }).id !== "string") {
    throw new Error(`createSession failed: HTTP ${status}`);
  }
  return body;
}

async function deleteSession(sessionId: string): Promise<void> {
  try {
    await request(`/sessions/${sessionId}`, { method: "DELETE" });
  } catch {
    // best-effort cleanup
  }
}

async function getMessages(sessionId: string): Promise<ApiMessage[]> {
  const { status, body } = await request<ApiMessage[]>(`/sessions/${sessionId}/messages`);
  if (status !== 200) throw new Error(`getMessages failed: HTTP ${status}`);
  return body;
}

async function getArtifact(artifactId: string): Promise<ArtifactRead> {
  const { status, body } = await request<ArtifactRead>(`/artifacts/${artifactId}`);
  if (status !== 200) throw new Error(`getArtifact failed: HTTP ${status}`);
  return body;
}

async function listArtifacts(sessionId: string): Promise<ArtifactSummary[]> {
  const { status, body } = await request<ArtifactSummary[]>(`/sessions/${sessionId}/artifacts`);
  if (status !== 200) throw new Error(`listArtifacts failed: HTTP ${status}`);
  return body;
}

async function internalRetrieve(
  query: string,
  topK = 5,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return request<Record<string, unknown>>("/internal/retrieve", {
    method: "POST",
    body: JSON.stringify({ query, top_k: topK }),
    headers: token ? { "X-Internal-Token": token } : {},
  });
}

/**
 * Stream one assistant turn via POST /api/chat, reusing the application's own
 * SseBufferParser + parseSseFrame (a live integration test of the parser too).
 */
async function runTurn(
  sessionId: string,
  message: string,
  opts: { skill?: string; abortOnFirstDelta?: boolean } = {},
): Promise<TurnResult> {
  const controller = new AbortController();
  const started = Date.now();
  const events: ChatEvent[] = [];
  const parser = new SseBufferParser();
  const summary: StreamSummary = {
    stopReason: "stop",
    grounded: null,
    messageId: null,
    model: null,
    provider: null,
    errorMessage: null,
    retryable: false,
  };
  let abortedBySignal = false;
  let sawTurnEnd = false;
  let sawError = false;

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message, ...(opts.skill ? { skill: opts.skill } : {}) }),
      signal: controller.signal,
    });
  } catch (err) {
    const name = hasAbortName(err);
    throw new AbortErrorLike(name, "fetch failed");
  }
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => "");
    throw new Error(`chat HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let citations: Array<Record<string, unknown>> = [];
  let usage: Record<string, unknown> | null = null;
  let artifact: ChatEvent | null = null;

  const handleEvent = (event: ChatEvent) => {
    events.push(event);
    if (opts.abortOnFirstDelta && event.type === "text_delta") controller.abort();
    switch (event.type) {
      case "turn_start":
        summary.model = event.data.model;
        summary.provider = event.data.provider;
        break;
      case "text_delta":
        text += event.data.text;
        break;
      case "citations":
        citations = event.data.citations as unknown as Array<Record<string, unknown>>;
        break;
      case "grounding":
        summary.grounded = event.data.grounded;
        break;
      case "usage":
        usage = event.data.usage as Record<string, unknown> | null;
        break;
      case "error":
        sawError = true;
        summary.errorMessage = event.data.message;
        summary.retryable = event.data.retryable;
        break;
      case "artifact":
        artifact = event;
        break;
      case "turn_end": {
        sawTurnEnd = true;
        summary.stopReason = event.data.stop_reason;
        summary.messageId = event.data.message_id;
        if (event.data.grounded !== null) summary.grounded = event.data.grounded;
        if (event.data.model) summary.model = event.data.model;
        if (event.data.provider) summary.provider = event.data.provider;
        break;
      }
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const event = parseSseFrame(frame);
        if (event === null) continue;
        handleEvent(event);
      }
    }
    for (const frame of parser.flush()) {
      const event = parseSseFrame(frame);
      if (event === null) continue;
      handleEvent(event);
    }
  } catch (err) {
    const name = hasAbortName(err);
    if (name === "AbortError") abortedBySignal = true;
    else throw err;
  } finally {
    reader.releaseLock();
  }

  if (abortedBySignal) throw new AbortErrorLike("AbortError", "aborted mid-stream");

  if (!sawTurnEnd && !sawError && !abortedBySignal) {
    summary.stopReason = "error";
    summary.errorMessage = "stream ended before turn_end";
  }

  return {
    events,
    text,
    citations,
    usage,
    artifact,
    summary,
    durationMs: Date.now() - started,
  };
}

class AbortErrorLike extends Error {
  name = "AbortError";
  constructor(name: string, message: string) {
    super(`(${name}) ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------

interface PromptResult {
  id: number;
  category: string;
  label: string;
  pass: boolean;
  checks: Array<{ check: string; pass: boolean; detail: string }>;
  error?: string;
  observed: Record<string, unknown>;
  durationMs: number;
}

type Runner = (ctx: AuditContext, r: PromptResult) => Promise<PromptResult>;

interface PromptDef {
  category: string;
  label: string;
  run: Runner;
}

interface AuditContext {
  createSession: typeof createSession;
  deleteSession: typeof deleteSession;
  getMessages: typeof getMessages;
  getArtifact: typeof getArtifact;
  listArtifacts: typeof listArtifacts;
  internalRetrieve: typeof internalRetrieve;
  runTurn: typeof runTurn;
}

function loadResults(): PromptResult[] {
  if (!existsSync(RESULTS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveResults(all: PromptResult[]): void {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

const prompts: PromptDef[] = [
  // ============================ IN-CORPUS (1-15) ============================
  ...[
    "What mistake do 99% of founders and sales reps make, according to Jason Lemkin?",
    "How did Claude become the fastest-growing AI product, according to the episode with Amol Avasare?",
    "Why has distribution become the most important moat, according to Evan Spiegel?",
    "What are the five questions to ask when your product stops growing, according to Jason Cohen?",
    "How did HubSpot start, and what does Brian Halligan say about scaling a company?",
    "What does Eric Ries say about building a company that withstands any era?",
    "What does Marc Andreessen say about the AI boom?",
    "What is the hidden pattern behind successful products, according to Mark Pincus?",
    "What does Nikhyl Singhal say about product managers being in trouble?",
    "What does Elena Verna say about growth teams and metrics?",
    "What does the podcast say about replacing a sales team with AI agents?",
    "What does the podcast say about retention as a growth lever?",
    "What does the podcast say about running pricing experiments?",
    "What does the podcast say about virality?",
    "What does the podcast say about net revenue retention (NRR)?",
  ].map((prompt, i): PromptDef => ({
    category: "in-corpus",
    label: `in #${i + 1}: ${prompt.slice(0, 70)}`,
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} in-corpus`);
      try {
        const turn = await ctx.runTurn(session.id, prompt);
        r.checks.push({ check: "turn_end stop", pass: turn.summary.stopReason === "stop", detail: `stop_reason=${turn.summary.stopReason}` });
        r.checks.push({ check: "grounded=true", pass: turn.summary.grounded === true, detail: `grounded=${turn.summary.grounded}` });
        r.checks.push({ check: "citations>=1", pass: turn.citations.length >= 1, detail: `${turn.citations.length} citations` });
        r.checks.push({ check: "text non-empty", pass: turn.text.trim().length > 20, detail: `${turn.text.trim().length} chars` });
        const msgs = await ctx.getMessages(session.id);
        const last = msgs[msgs.length - 1];
        r.observed.text = turn.text.slice(0, 200);
        r.observed.citations = turn.citations;
        r.observed.messageCount = msgs.length;
        r.observed.grounded = turn.summary.grounded;
        r.observed.persisted = last ? { role: last.role, citations: last.citations?.length, grounding: last.grounding } : null;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  })),

  // =========================== OUT-OF-CORPUS (16-23) ==========================
  ...[
    "Describe the plot of Pride and Prejudice.",
    "What is the recipe for a classic French ratatouille?",
    "How does a jet engine work?",
    "What were the key causes of the French Revolution?",
    "How do you house-train a puppy?",
    "Explain how the Tour de France points classification works.",
    "What is the capital of Nigeria and which languages are spoken there?",
    "Explain the rules of cricket in detail.",
  ].map((prompt, i): PromptDef => ({
    category: "out-of-corpus",
    label: `out #${i + 1}: ${prompt.slice(0, 70)}`,
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} out-of-corpus`);
      try {
        const turn = await ctx.runTurn(session.id, prompt);
        r.checks.push({ check: "turn_end present", pass: turn.summary.stopReason === "stop", detail: `stop_reason=${turn.summary.stopReason}` });
        r.checks.push({ check: "grounded=false", pass: turn.summary.grounded === false, detail: `grounded=${turn.summary.grounded}` });
        const msgs = await ctx.getMessages(session.id);
        const last = msgs[msgs.length - 1];
        r.observed.text = turn.text.slice(0, 200);
        r.observed.grounded = turn.summary.grounded;
        r.observed.persistedGrounding = last?.grounding ?? null;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  })),

  // ============================= MULTI-TURN (24-28) =============================
  ...[
    { q1: "Summarize what the podcast says about product-market fit.", q2: "My first question was about which topic? Answer with the exact topic." },
    { q1: "What does the podcast say about HubSpot's growth?", q2: "Compare that to what the podcast says about distribution." },
    { q1: "List two lessons the podcast teaches about pricing.", q2: "Which guest gave the first lesson? Name the person if you can." },
    { q1: "Give a one-sentence summary of the Amol Avasare episode.", q2: "In the episode, who interviewed Amol Avasare? Say whether that is grounded in the transcript." },
    { q1: "In three bullets, what does Jason Lemkin say about AI agents in sales?", q2: "Rewrite those three bullets as one open-ended question a founder could ask." },
  ].map((pair, i): PromptDef => ({
    category: "multi-turn",
    label: `history #${i + 1}: ${pair.q1.slice(0, 60)}`,
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} multi-turn`);
      try {
        const t1 = await ctx.runTurn(session.id, pair.q1);
        const t2 = await ctx.runTurn(session.id, pair.q2);
        r.checks.push({ check: "turn1 stop", pass: t1.summary.stopReason === "stop", detail: `stop_reason=${t1.summary.stopReason}` });
        r.checks.push({ check: "turn2 stop", pass: t2.summary.stopReason === "stop", detail: `stop_reason=${t2.summary.stopReason}` });
        r.checks.push({ check: "turn2 text non-empty", pass: t2.text.trim().length > 10, detail: `${t2.text.trim().length} chars` });
        const msgs = await ctx.getMessages(session.id);
        r.checks.push({ check: "2 turns persisted (>=4 msgs)", pass: msgs.length >= 4, detail: `${msgs.length} messages` });
        r.checks.push({ check: "turn1 citation retained", pass: t1.citations.length >= 1, detail: `${t1.citations.length}` });
        r.observed.turn2Text = t2.text.slice(0, 200);
        r.observed.turn1Grounded = t1.summary.grounded;
        r.observed.turn2Grounded = t2.summary.grounded;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  })),

  // =========================== SESSION ISOLATION (29-31) ===========================
  {
    category: "isolation",
    label: "isolation #1: concurrent sessions do not cross-talk",
    run: async (ctx, r) => {
      const P = "What does the podcast say about distribution as a moat?";
      const a = await ctx.createSession(`${SESSION_TITLE_PREFIX} isolation-A`);
      const b = await ctx.createSession(`${SESSION_TITLE_PREFIX} isolation-B`);
      try {
        const tA = await ctx.runTurn(a.id, P);
        const msgsA0 = await ctx.getMessages(a.id);
        const tB = await ctx.runTurn(b.id, P);
        const msgsA1 = await ctx.getMessages(a.id);
        const msgsB = await ctx.getMessages(b.id);
        r.checks.push({ check: "A grounded", pass: tA.summary.grounded === true, detail: `grounded=${tA.summary.grounded}` });
        r.checks.push({ check: "B grounded", pass: tB.summary.grounded === true, detail: `grounded=${tB.summary.grounded}` });
        r.checks.push({ check: "A unchanged after B turn", pass: msgsA1.length === msgsA0.length && msgsA1[msgsA1.length - 1].id === msgsA0[msgsA0.length - 1].id, detail: `A before=${msgsA0.length} after=${msgsA1.length}` });
        r.checks.push({ check: "distinct message ids", pass: msgsA0[0].id !== msgsB[0].id, detail: "ids differ" });
        r.checks.push({ check: "B persisted", pass: msgsB.length >= 2, detail: `${msgsB.length} messages` });
        r.observed.aLast = msgsA1[msgsA1.length - 1]?.id;
        r.observed.bLast = msgsB[msgsB.length - 1]?.id;
      } finally {
        await ctx.deleteSession(a.id);
        await ctx.deleteSession(b.id);
      }
      return r;
    },
  },
  {
    category: "isolation",
    label: "isolation #2: deleting B leaves A intact",
    run: async (ctx, r) => {
      const a = await ctx.createSession(`${SESSION_TITLE_PREFIX} isolation-delA`);
      const b = await ctx.createSession(`${SESSION_TITLE_PREFIX} isolation-delB`);
      try {
        await ctx.runTurn(a.id, "What does the podcast say about retention?");
        const msgsA0 = await ctx.getMessages(a.id);
        await ctx.deleteSession(b.id);
        const { status } = await request(`/sessions/${b.id}`, { method: "GET" });
        const msgsA1 = await ctx.getMessages(a.id);
        r.checks.push({ check: "B returns 404 after delete", pass: status === 404, detail: `HTTP ${status}` });
        r.checks.push({ check: "A unaffected by B delete", pass: msgsA1.length === msgsA0.length, detail: `A before=${msgsA0.length} after=${msgsA1.length}` });
      } finally {
        await ctx.deleteSession(a.id);
      }
      return r;
    },
  },
  {
    category: "isolation",
    label: "isolation #3: artifact scoping stays per-session",
    run: async (ctx, r) => {
      const a = await ctx.createSession(`${SESSION_TITLE_PREFIX} iso-artA`);
      const b = await ctx.createSession(`${SESSION_TITLE_PREFIX} iso-artB`);
      try {
        const tA = await ctx.runTurn(a.id, "Create an HTML view of a weekly growth checklist.", { skill: "artifact" });
        const tB = await ctx.runTurn(b.id, "Create an HTML view of a pricing audit template.", { skill: "artifact" });
        const artsA = await ctx.listArtifacts(a.id);
        const artsB = await ctx.listArtifacts(b.id);
        r.checks.push({ check: "A artifact event", pass: Boolean(tA.artifact), detail: tA.artifact ? "received" : "missing" });
        r.checks.push({ check: "B artifact event", pass: Boolean(tB.artifact), detail: tB.artifact ? "received" : "missing" });
        r.checks.push({ check: "A artifact list non-empty", pass: artsA.length >= 1, detail: `${artsA.length}` });
        r.checks.push({ check: "B artifact list non-empty", pass: artsB.length >= 1, detail: `${artsB.length}` });
        r.checks.push({ check: "A list has no B artifact", pass: artsA.every((art) => !artsB.some((bArt) => bArt.id === art.id)), detail: "no cross-session ids" });
        r.observed.artsA = artsA.map((art) => art.id);
        r.observed.artsB = artsB.map((art) => art.id);
      } finally {
        await ctx.deleteSession(a.id);
        await ctx.deleteSession(b.id);
      }
      return r;
    },
  },

  // ============================== ARTIFACTS (32-37) ==============================
  ...[
    { skill: "artifact", text: "Generate an HTML report on Product-Market Fit Milestones" },
    { skill: "artifact", text: "Create an HTML report on the ten best pricing experiments" },
    { skill: "artifact", text: "Create a standalone markdown document about growth loops" },
    { skill: "artifact", text: "Produce an HTML view of a startup OKR template" },
    { skill: "artifact", text: "Create a standalone markdown document about retention metrics" },
    { skill: "artifact", text: "Generate a weekly growth report template as HTML" },
  ].map((def, i): PromptDef => ({
    category: "artifact",
    label: `artifact #${i + 1}: ${def.text.slice(0, 60)}`,
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} artifact`);
      try {
        const turn = await ctx.runTurn(session.id, def.text, { skill: def.skill });
        r.checks.push({ check: "artifact event received", pass: Boolean(turn.artifact), detail: turn.artifact ? "yes" : "no artifact event" });
        if (turn.artifact && turn.artifact.type === "artifact") {
          const data = turn.artifact.data;
          r.checks.push({ check: "artifact has id", pass: Boolean(data.id), detail: String(data.id) });
          r.checks.push({ check: "artifact has content>50", pass: (data.content ?? "").length > 50, detail: `${(data.content ?? "").length} chars` });
          r.checks.push({ check: "kind is html|markdown", pass: data.kind === "html" || data.kind === "markdown", detail: data.kind });
          const persisted = await ctx.getArtifact(data.id);
          r.checks.push({ check: "GET /artifacts/:id 200", pass: persisted.id === data.id, detail: `retrieved id=${persisted.id}` });
          r.checks.push({ check: "persisted session_id matches", pass: persisted.session_id === session.id, detail: persisted.session_id });
          r.checks.push({ check: "persisted content non-empty", pass: persisted.content.length > 50, detail: `${persisted.content.length} chars` });
          const listed = await ctx.listArtifacts(session.id);
          r.checks.push({ check: "listed under session", pass: listed.some((art) => art.id === data.id), detail: `${listed.length} artifacts` });
          r.observed.kind = data.kind;
          r.observed.title = data.title;
          r.observed.contentLen = (data.content ?? "").length;
          r.observed.hasScriptTag = /<script/i.test(persisted.content);
          r.observed.hasHandlerAttr = /onerror=|onload=|onclick=/i.test(persisted.content);
          r.observed.hasJavascriptUrl = /javascript:/i.test(persisted.content);
        } else {
          r.observed.stopReason = turn.summary.stopReason;
        }
        r.checks.push({ check: "turn_end stop", pass: turn.summary.stopReason === "stop", detail: `stop_reason=${turn.summary.stopReason}` });
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  })),

  // ============================== SHIP 30 (38-41) ==============================
  ...[
    "Write a Ship 30 for 30 essay about the importance of distribution for consumer startups.",
    "Write a Ship 30 essay on retention being the real moat.",
    "Turn my idea into a Ship 30 essay: AI changes distribution.",
    "Draft a Ship 30 for 30 essay about how to find product-market fit.",
  ].map((prompt, i): PromptDef => ({
    category: "ship30",
    label: `ship30 #${i + 1}: ${prompt.slice(0, 60)}`,
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} ship30`);
      try {
        const turn = await ctx.runTurn(session.id, prompt);
        const msgs = await ctx.getMessages(session.id);
        const last = msgs[msgs.length - 1];
        const words = turn.text.trim() ? turn.text.trim().split(/\s+/).length : 0;
        const headings = (turn.text.match(/^#{1,6}\s+\S[^\n]*$/gm) ?? []).length;
        const bold = /\*\*[^*\n]+\*\*/.test(turn.text);
        const takeaway = /\b(takeaway|actionable|what to do|next step)\b/i.test(turn.text);
        const hook = turn.text.trim().split(/\n\s*\n+/)[0]?.trim()?.split(/\s+/).length ?? 0;
        r.checks.push({ check: "turn_end stop", pass: turn.summary.stopReason === "stop", detail: `stop_reason=${turn.summary.stopReason}` });
        r.checks.push({ check: "skill persisted ship30_essay", pass: last?.skill === "ship30_essay", detail: `skill=${last?.skill ?? "null"}` });
        r.checks.push({ check: "essay text present", pass: turn.text.trim().length > 0, detail: `${turn.text.trim().length} chars` });
        r.checks.push({ check: "wordcount>=800", pass: words >= 800, detail: `${words} words` });
        r.checks.push({ check: ">=2 headings", pass: headings >= 2, detail: `${headings} headings` });
        r.checks.push({ check: "bold emphasis", pass: bold, detail: bold ? "yes" : "no" });
        r.checks.push({ check: "takeaway section", pass: takeaway, detail: takeaway ? "yes" : "no" });
        r.checks.push({ check: "hook>=8 words", pass: hook >= 8, detail: `hook ${hook} words` });
        r.observed.words = words;
        r.observed.headings = headings;
        r.observed.grounded = turn.summary.grounded;
        r.observed.citations = turn.citations.length;
        r.observed.prev = turn.text.slice(0, 300);
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  })),

  // ============================ ABORT (42-43) ============================
  {
    category: "abort",
    label: "abort #1: mid-stream abort persists partial assistant text",
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} abort`);
      try {
        const turn = await ctx.runTurn(
          session.id,
          "Explain in detail what mistake 99% of founders and sales reps make and how to avoid it.",
          { abortOnFirstDelta: true },
        );
        r.checks.push({ check: "fetch rejected (AbortError)", pass: false, detail: "turn unexpectedly resolved" });
        r.observed.turnEnd = turn.summary.stopReason;
        return r;
      } catch (err) {
        const name = hasAbortName(err);
        r.checks.push({ check: "fetch rejected (AbortError)", pass: name === "AbortError", detail: `name=${name}` });
        const partial = await waitFor(async () => {
          const msgs = await ctx.getMessages(session.id);
          const assistants = msgs.filter((m) => m.role === "assistant");
          return assistants.length >= 1 && assistants[assistants.length - 1].content.trim().length > 0;
        });
        const msgs = await ctx.getMessages(session.id);
        const assistants = msgs.filter((m) => m.role === "assistant");
        const partialText = assistants[assistants.length - 1]?.content ?? "";
        r.checks.push({ check: "partial assistant msg persisted", pass: partial && partialText.trim().length > 0, detail: `assistant msgs=${assistants.length}, partial len=${partialText.trim().length}` });
        r.checks.push({ check: "user msg persisted", pass: msgs.some((m) => m.role === "user"), detail: `${msgs.filter((m) => m.role === "user").length} user msgs` });
        r.observed.partialText = partialText.slice(0, 200);
        r.observed.messageCount = msgs.length;
        return r;
      } finally {
        await ctx.deleteSession(session.id);
      }
    },
  },
  {
    category: "abort",
    label: "abort #2: abort before any delta does not crash the session",
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} abort-early`);
      try {
        const controller = new AbortController();
        const started = Date.now();
        let name = "";
        try {
          const res = await fetch(`${BASE}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: session.id, message: "Write a long detailed essay about pricing strategy." }),
            signal: controller.signal,
          });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          const parser = new SseBufferParser();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
              const event = parseSseFrame(frame);
              if (event?.type === "turn_start") controller.abort();
            }
          }
          await reader.cancel();
        } catch (err) {
          name = hasAbortName(err);
        }
        r.checks.push({ check: "abort observed", pass: name === "AbortError", detail: `name=${name}` });
        const ok = await waitFor(async () => {
          const msgs = await ctx.getMessages(session.id);
          return msgs.some((m) => m.role === "user");
        });
        r.checks.push({ check: "user msg still persisted", pass: ok, detail: "user message saved" });
        r.observed.durationMs = Date.now() - started;
        return r;
      } finally {
        await ctx.deleteSession(session.id);
      }
    },
  },

  // ======================= CITATION GENUINENESS (44-46) =======================
  ...[
    "What does the podcast say about distribution as a moat?",
    "What does the podcast say about how Claude's growth in AI came to pass?",
    "What does Jason Lemkin say about replacing sales teams with AI agents?",
  ].map((prompt, i): PromptDef => ({
    category: "citation-genuine",
    label: `citation-genuine #${i + 1}: ${prompt.slice(0, 60)}`,
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} citations`);
      try {
        const turn = await ctx.runTurn(session.id, prompt);
        const msgs = await ctx.getMessages(session.id);
        const last = msgs[msgs.length - 1];
        const persistedCitations = last?.citations ?? [];
        r.checks.push({ check: "stream citations>=1", pass: turn.citations.length >= 1, detail: `${turn.citations.length}` });
        r.checks.push({ check: "persisted citations>=1", pass: persistedCitations.length >= 1, detail: `${persistedCitations.length}` });

        const retr = await ctx.internalRetrieve(prompt);
        const retrResults = (retr.body.results ?? []) as Array<Record<string, unknown>>;
        const retrContents = retrResults.map((chunk) => String(chunk.content ?? ""));
        const clipped = retrContents.map((content) => content.slice(0, 280));

        let anyGenuine = false;
        const matchDetail: string[] = [];
        for (const cit of turn.citations) {
          const snippet = String(cit.snippet ?? "");
          const snippetClipped = snippet.slice(0, 280);
          if (snippet && clipped.some((c) => c === snippetClipped || snippetClipped.startsWith(c.slice(0, 40)) || c.startsWith(snippetClipped.slice(0, 40)))) {
            anyGenuine = true;
            matchDetail.push(cit.guest as string);
          }
        }
        r.checks.push({ check: "snippet matches live retriever chunk", pass: anyGenuine, detail: matchDetail.length ? `matched guests: ${matchDetail.slice(0, 3).join(", ")}` : "no overlap" });
        r.checks.push({ check: "citation guest present", pass: turn.citations.some((c) => Boolean(c.guest)), detail: `guests=${turn.citations.map((c) => c.guest).join("|")}` });
        r.checks.push({ check: "citation episode present", pass: turn.citations.some((c) => Boolean(c.episode)), detail: `episodes=${turn.citations.map((c) => c.episode).join("|")}` });
        r.observed.snippets = turn.citations.map((c) => String(c.snippet ?? "").slice(0, 80));
        r.observed.retrieverTop = retrContents[0]?.slice(0, 100) ?? "(empty)";
        r.observed.grounded = turn.summary.grounded;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  })),

  // ============================ SKILLS (47-48) ============================
  {
    category: "skills",
    label: "skills #1: explicit ship30_essay skill overrides casual message",
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} skills-explicit`);
      try {
        const turn = await ctx.runTurn(session.id, "List three pricing strategies.", { skill: "ship30_essay" });
        const msgs = await ctx.getMessages(session.id);
        const last = msgs[msgs.length - 1];
        r.checks.push({ check: "turn_end stop", pass: turn.summary.stopReason === "stop", detail: `stop_reason=${turn.summary.stopReason}` });
        r.checks.push({ check: "explicit skill persisted", pass: last?.skill === "ship30_essay", detail: `user skill=${msgs[msgs.length - 2]?.skill ?? "null"}, assistant skill=${last?.skill ?? "null"}` });
        r.checks.push({ check: "text present", pass: turn.text.trim().length > 0, detail: `${turn.text.trim().length} chars` });
        r.observed.assistantSkill = last?.skill ?? null;
        r.observed.userSkill = msgs[msgs.length - 2]?.skill ?? null;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  },
  {
    category: "skills",
    label: "skills #2: 'essay' without a writing verb stays a normal turn",
    run: async (ctx, r) => {
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} skills-no-verb`);
      try {
        const turn = await ctx.runTurn(session.id, "I have an essay due about growth. What tools do you recommend I use?");
        const msgs = await ctx.getMessages(session.id);
        const last = msgs[msgs.length - 1];
        r.checks.push({ check: "turn_end stop", pass: turn.summary.stopReason === "stop", detail: `stop_reason=${turn.summary.stopReason}` });
        r.checks.push({ check: "no skill auto-applied", pass: last?.skill === null, detail: `skill=${last?.skill ?? "null"}` });
        r.checks.push({ check: "grounded or normal reply", pass: turn.summary.stopReason === "stop", detail: `grounded=${turn.summary.grounded}` });
        r.observed.assistantSkill = last?.skill ?? null;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  },

  // ======================= RESILIENCE / SECURITY (49-50) =======================
  {
    category: "resilience",
    label: "resilience #1: chat to a non-existent session returns 404",
    run: async (_ctx, r) => {
      const { status, body } = await request<Record<string, unknown>>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ session_id: randomUuid(), message: "Hello?" }),
      });
      r.checks.push({ check: "404 with error body", pass: status === 404 && Boolean(body.error), detail: `HTTP ${status} body=${JSON.stringify(body).slice(0, 120)}` });
      return r;
    },
  },
  {
    category: "resilience",
    label: "resilience #2: internal retrieval auth + artifact XSS sweep at rest",
    run: async (ctx, r) => {
      const retr = await ctx.internalRetrieve("distribution moat");
      r.checks.push({ check: "internal retrieval reachable", pass: retr.status === 200 || retr.status === 401, detail: `HTTP ${retr.status} (200=open dev config, 401=token enforced)` });
      r.checks.push({ check: "retrieval body shape ok when open", pass: retr.status !== 200 || Array.isArray(retr.body.results), detail: retr.status === 200 ? `${(retr.body.results as unknown[]).length} results` : "n/a" });
      const session = await ctx.createSession(`${SESSION_TITLE_PREFIX} xss`);
      let persistedContent = "";
      try {
        const turn = await ctx.runTurn(session.id, "Create an HTML page that includes an <img> tag with an onerror attribute as an example, about growth metrics.", { skill: "artifact" });
        if (turn.artifact && turn.artifact.type === "artifact" && turn.artifact.data.id) {
          persistedContent = (await ctx.getArtifact(turn.artifact.data.id)).content;
        }
        const dangerous = /<script|onerror\s*=|onload\s*=|javascript:/i.test(persistedContent);
        r.checks.push({ check: "model output carries no executable payload", pass: !dangerous, detail: dangerous ? "payload found at rest (will verify render-layer sanitization separately)" : "no payload persisted" });
        r.observed.contentLen = persistedContent.length;
        r.observed.hasPayload = dangerous;
        r.observed.grounded = turn.summary.grounded;
      } finally {
        await ctx.deleteSession(session.id);
      }
      return r;
    },
  },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const arg = (key: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
};

const categoryFilter = arg("category")?.split(",").filter(Boolean);
const limit = Number(arg("limit") ?? "0") || 0;
const only = Number(arg("only") ?? "0") || 0;

const ctx: AuditContext = {
  createSession,
  deleteSession,
  getMessages,
  getArtifact,
  listArtifacts,
  internalRetrieve,
  runTurn,
};

async function main(): Promise<void> {
  const all = loadResults();
  const doneIds = new Set(all.map((p) => p.id));
  let pass = 0;
  let fail = 0;
  let errCount = 0;
  let ran = 0;

  for (let i = 0; i < prompts.length; i++) {
    const id = i + 1;
    if (only && id !== only) continue;
    if (categoryFilter && !categoryFilter.includes(prompts[i].category)) continue;
    if (doneIds.has(id)) continue;
    if (limit && ran >= limit) break;

    const def = prompts[i];
    const base: PromptResult = {
      id,
      category: def.category,
      label: def.label,
      pass: false,
      checks: [],
      observed: {},
      durationMs: 0,
    };
    const started = Date.now();
    let result: PromptResult;
    try {
      result = await Promise.race([
        def.run(ctx, base),
        wait(Number(process.env.AUDIT_PROMPT_TIMEOUT_MS ?? PROMPT_TIMEOUT_MS)).then(() => {
          throw new Error(`timeout after ${PROMPT_TIMEOUT_MS / 1000}s`);
        }),
      ] as [Promise<PromptResult>, Promise<never>]);
      result.pass = result.checks.length > 0 && result.checks.every((c) => c.pass);
      if (result.pass) pass++;
      else fail++;
    } catch (err) {
      result = base;
      result.error = err instanceof Error ? err.message : String(err);
      errCount++;
    }
    result.durationMs = Date.now() - started;
    all.push(result);
    saveResults(all);
    ran++;

    const failedChecks = result.checks.filter((c) => !c.pass);
    console.log(
      `[${result.pass ? "PASS" : result.error ? "ERROR" : "FAIL"}] #${id} ${result.category} :: ${def.label} ` +
        `(+${(result.durationMs / 1000).toFixed(1)}s${result.error ? ` err=${result.error}` : ""})`,
    );
    for (const c of failedChecks) console.log(`      ! ${c.check} => ${c.detail}`);
  }

  console.log(`\nAUDIT RUN COMPLETE — pass=${pass} fail=${fail} error=${errCount} ran=${ran} saved=${all.length} -> ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("audit-50 crashed:", err);
  process.exit(2);
});