import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig } from "./config.ts";
import { defaultModel, resolveModel } from "./runtime.ts";
import {
  createSearchTranscriptsTool,
  SEARCH_TRANSCRIPTS_TOOL_NAME,
} from "./tools/search-transcripts.ts";

export interface ModelSelection {
  provider?: string;
  id?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LiveSession {
  id: string;
  session: AgentSession;
  modelLabel: string;
  manager: SessionManager;
}

/**
 * In-process pool of Pi agent sessions keyed by client session_id.
 * Sessions are in-memory only; persistence lives in FastAPI/Postgres.
 */
export class SessionPool {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly runtime: ModelRuntime,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** Create the session on first use; a live session is reused otherwise. */
  async ensure(
    id: string,
    selection?: ModelSelection,
    history?: HistoryMessage[],
  ): Promise<LiveSession> {
    const existing = this.sessions.get(id);
    if (existing) {
      if (selection?.provider && selection?.id) {
        await this.applyModel(existing, selection);
      }
      return existing;
    }

    const model = this.resolveSelection(selection);
    const sessionManager = SessionManager.inMemory();
    if (history && history.length > 0) {
      seedHistory(sessionManager, history, model);
      console.log(
        JSON.stringify({
          level: "info",
          msg: "session_history_seeded",
          session_id: id,
          history_len: history.length,
          projected_messages: sessionManager.buildSessionProjection().messages.length,
        }),
      );
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cfg.cwd,
      agentDir: this.cfg.agentDir,
      systemPromptOverride: () => `You are Lenny Growth Assistant, an AI assistant specializing in startup growth, product management, and Lenny's Podcast.

You support two distinct modes of interaction:
1. General conversation & advice (e.g., productivity, daily routines, programming, timetables, general explanations, and follow-up application of advice):
   Answer directly, clearly, and practically using your own general knowledge.
   Do NOT cite podcast guests, do NOT invent transcripts, and NEVER say "Based on the search transcript" for general questions.
2. Lenny's Podcast questions (e.g., specific guests, episodes, or growth topics from the podcast):
   Use the search_transcripts tool when available to retrieve evidence.
   Name the episode and guest for substantive claims.
   If no confident evidence is found, state honestly that the transcript library does not cover the topic; never fabricate guests or citations.

CORE PRINCIPLES FOR ALL INTERACTIONS:
- Instruction & Constraint Following: Carefully read and strictly respect all explicit instructions in the user's latest prompt. Respect all numerical limits, time caps, deadlines, budgets, and resource constraints. When giving a plan or schedule, ensure the hours or costs allocated to all activities strictly add up to less than or equal to the stated limit. Verify your arithmetic before answering.
- Unbuilt / Unimplemented Products: When a user states or implies a product or feature is not yet built, do NOT claim, assume, or recommend offering working software demos, automated features, or live trials. Instead, recommend direct problem discovery interviews, concierge (manual) workflows, pre-orders, paper/clickable mockups, or prototypes. Clearly distinguish verified features from unbuilt concepts.
- Corrections & Challenges: When the user points out a mistake, constraint violation, or challenges an earlier answer, explicitly acknowledge and own the mistake with professional humility (e.g., "You're right, my previous plan exceeded your limit..."), explain the adjustment, and provide a corrected solution that strictly adheres to the limits. Never defend incorrect answers or repeat violations.
- Honesty & Calibration: Clearly distinguish verified facts, assumptions, and suggestions. Describe business outcomes as validation goals and hypotheses to test, never as guaranteed successes.
- Directness: Answer the actual question without repeating earlier content unnecessarily. Ask a concise clarifying question only if essential information is truly missing.`,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: this.cfg.cwd,
      agentDir: this.cfg.agentDir,
      resourceLoader,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: "off",
      noTools: "all",
      tools: [SEARCH_TRANSCRIPTS_TOOL_NAME],
      customTools: [createSearchTranscriptsTool(this.cfg) as unknown as ToolDefinition],
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
    });

    const live: LiveSession = { id, session, modelLabel: labelFor(model), manager: sessionManager };
    this.sessions.set(id, live);
    return live;
  }

  private resolveSelection(selection?: ModelSelection): Model<any> {
    if (selection?.provider && selection?.id) {
      return resolveModel(this.runtime, selection.provider, selection.id);
    }
    return defaultModel(this.runtime, this.cfg);
  }

  private async applyModel(live: LiveSession, selection: ModelSelection): Promise<void> {
    const next = this.resolveSelection(selection);
    const nextLabel = labelFor(next);
    if (nextLabel === live.modelLabel) return;
    await live.session.setModel(next);
    live.modelLabel = nextLabel;
  }

  async abort(id: string): Promise<boolean> {
    const live = this.sessions.get(id);
    if (!live) return false;
    await live.session.abort();
    return true;
  }

  dispose(id: string): boolean {
    const live = this.sessions.get(id);
    if (!live) return false;
    try {
      live.session.dispose();
    } catch {
      // disposal is best-effort
    }
    this.sessions.delete(id);
    return true;
  }

  disposeAll(): void {
    for (const id of this.ids()) this.dispose(id);
  }
}

function labelFor(model: Model<any>): string {
  const descriptor = model as { provider?: string; id?: string };
  return `${descriptor.provider ?? "unknown"}/${descriptor.id ?? "unknown"}`;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * Replay distilled user/assistant history into a freshly created in-memory
 * session so the Pi agent can answer follow-ups that reference earlier turns
 * (e.g. "what did I ask first?"). Timestamps are monotonically increasing to
 * preserve order; assistant messages are attributed to the resolving model.
 */
export function seedHistory(
  manager: SessionManager,
  history: HistoryMessage[],
  model: Model<any>,
): void {
  const now = Date.now();
  history.forEach((message, index) => {
    const timestamp = now + index;
    if (message.role === "user") {
      manager.appendMessage({ role: "user", content: message.content, timestamp });
      return;
    }
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp,
    });
  });
}
