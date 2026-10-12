import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { streamChat } from "../api/sse";
import { ChatPanel } from "./ChatPanel";
import { SessionSidebar } from "./SessionSidebar";
import { StatusBar } from "./StatusBar";
import { ArtifactViewer } from "./ArtifactViewer";
import type {
  ChatEvent,
  ClientConfig,
  ClientMessage,
  HealthStatus,
  SessionSummary,
  ArtifactRead,
} from "../types";

const HEALTH_POLL_MS = 20_000;
const MESSAGE_CHAR_LIMIT_DEFAULT = 8000;
const SESSION_TITLE_MAX = 60;

type BackendStatus = "checking" | "ok" | "degraded" | "down";

function emptyMessage(
  id: string,
  role: "user" | "assistant",
  extra: Record<string, unknown> = {},
): ClientMessage {
  return {
    id,
    role,
    content: "",
    provider: null,
    skill: null,
    citations: [],
    model: null,
    grounding: null,
    token_usage: null,
    created_at: new Date().toISOString(),
    ...extra,
  } as ClientMessage;
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeSessions(list: SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    if (!s?.id || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactRead | null>(null);
  const [artifactViewerOpen, setArtifactViewerOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    return (localStorage.getItem("theme") as any) || "system";
  });

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastUserPromptRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionSummary[]>([]);
  sessionsRef.current = sessions;

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const list = await api.getMessages(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        setMessages(list);
      }
    } catch {
      // non-fatal; messages will be empty until next attempt
    }
  }, []);

  const loadArtifacts = useCallback(async (sessionId: string) => {
    try {
      const artifacts = await api.listArtifacts(sessionId);
      if (artifacts.length > 0 && activeSessionIdRef.current === sessionId) {
        // Load the latest artifact
        const latest = artifacts[artifacts.length - 1];
        const fullArtifact = await api.getArtifact(latest.id);
        setActiveArtifact(fullArtifact);
      } else if (activeSessionIdRef.current === sessionId) {
        setActiveArtifact(null);
      }
    } catch {
      // ignore
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.listSessions();
      setSessions(dedupeSessions(list));
    } catch {
      // non-fatal: a later refresh will retry
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const result = await api.health();
      setHealth(result);
      setBackendStatus(result.status === "ok" ? "ok" : "degraded");
    } catch {
      setHealth(null);
      setBackendStatus("down");
    }
  }, []);

  const createSession = useCallback(async () => {
    // If the active conversation is already empty and unused, reuse it
    if (messages.length === 0 && activeSessionIdRef.current) {
      setMobileSidebarOpen(false);
      return;
    }

    abortRef.current?.abort();
    setLoadingSessions(true);
    try {
      const session = await api.createSession();
      setSessions((prev) => dedupeSessions([session, ...prev]));
      setActiveSessionId(session.id);
      setMessages([]);
      setActiveArtifact(null);
      setArtifactViewerOpen(false);
      setError(null);
      setMobileSidebarOpen(false);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Failed to create a conversation.",
      );
    } finally {
      setLoadingSessions(false);
    }
  }, [messages.length]);

  const selectSession = useCallback(
    (id: string) => {
      if (id === activeSessionIdRef.current) {
        setMobileSidebarOpen(false);
        return;
      }
      abortRef.current?.abort();
      setError(null);
      setActiveSessionId(id);
      setMessages([]);
      setActiveArtifact(null);
      setMobileSidebarOpen(false);
      void loadMessages(id);
      void loadArtifacts(id);
    },
    [loadMessages, loadArtifacts],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id);
        setSessions((prev) => dedupeSessions(prev.filter((s) => s.id !== id)));
        if (activeSessionIdRef.current === id) {
          // Switch to the next available session or create one
          const remaining = sessionsRef.current.filter((s) => s.id !== id);
          if (remaining.length > 0) {
            selectSession(remaining[0].id);
          } else {
            setActiveSessionId(null);
            setMessages([]);
            await createSession();
          }
        }
      } catch (e) {
        setError(
          e instanceof ApiError ? e.message : "Failed to delete the conversation.",
        );
      }
    },
    [selectSession, createSession],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      try {
        const updated = await api.renameSession(id, title.slice(0, SESSION_TITLE_MAX));
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, title: updated.title } : s)),
        );
      } catch (e) {
        setError(
          e instanceof ApiError ? e.message : "Failed to rename the conversation.",
        );
      }
    },
    [],
  );

  // First boot: config + health + sessions
  useEffect(() => {
    void api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null));

    void refreshHealth();
    const healthTimer = setInterval(() => void refreshHealth(), HEALTH_POLL_MS);

    void (async () => {
      try {
        const list = await api.listSessions();
        const deduped = dedupeSessions(list);
        setSessions(deduped);
        if (deduped.length > 0) {
          setActiveSessionId(deduped[0].id);
        } else {
          await createSession();
        }
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Failed to load conversations.",
        );
      } finally {
        setLoadingSessions(false);
      }
    })();

    return () => clearInterval(healthTimer);
  }, [refreshHealth, createSession]);

  // Load history when the active session changes
  useEffect(() => {
    if (!activeSessionId) return;
    void loadMessages(activeSessionId);
  }, [activeSessionId, loadMessages]);

  // Keyboard shortcut: Esc stops an in-flight reply
  useEffect(() => {
    if (!streaming) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") abortRef.current?.abort();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streaming]);

  // Theme observer
  useEffect(() => {
    const applyTheme = (t: "light" | "dark") => {
      document.documentElement.setAttribute("data-theme", t);
    };

    if (theme === "system") {
      const matcher = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(matcher.matches ? "dark" : "light");
      const listener = (e: MediaQueryListEvent) => applyTheme(e.matches ? "dark" : "light");
      matcher.addEventListener("change", listener);
      localStorage.removeItem("theme");
      return () => matcher.removeEventListener("change", listener);
    } else {
      applyTheme(theme);
      localStorage.setItem("theme", theme);
    }
  }, [theme]);

  const updateStreamingAssistant = useCallback(
    (id: string, patch: (message: ClientMessage) => ClientMessage) => {
      setMessages((prev) =>
        prev.map((message) => (message.id === id ? patch(message) : message)),
      );
    },
    [],
  );

  const finishTurn = useCallback(
    async (
      sessionId: string,
      status: "done" | "stopped" | "error",
      errorMessage?: string,
    ) => {
      setStreaming(false);
      abortRef.current = null;
      if (errorMessage) setError(errorMessage);
      await loadMessages(sessionId);
      await refreshSessions();
      if (status === "done") {
        const session = sessionsRef.current.find((s) => s.id === sessionId);
        const prompt = lastUserPromptRef.current;
        if (session && session.title === null && prompt) {
          try {
            await api.renameSession(
              sessionId,
              prompt.slice(0, SESSION_TITLE_MAX),
            );
            await refreshSessions();
          } catch {
            // best-effort auto-title
          }
        }
      }
    },
    [loadMessages, refreshSessions],
  );

  const handleSend = useCallback(
    async (text: string, skill?: string) => {
      if (!activeSessionIdRef.current) return;
      const sessionId = activeSessionIdRef.current;
      setError(null);

      const userMessage = emptyMessage(uniqueId("user"), "user", {
        content: text,
      });
      const assistantId = uniqueId("assistant");
      const assistantMessage = emptyMessage(assistantId, "assistant", {
        status: "streaming",
      });
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const onEvent = (event: ChatEvent) => {
        if (event.type === "text_delta") {
          updateStreamingAssistant(assistantId, (m) => ({
            ...m,
            content: m.content + event.data.text,
          }));
        } else if (event.type === "citations") {
          updateStreamingAssistant(assistantId, (m) => ({
            ...m,
            citations: event.data.citations,
          }));
        } else if (event.type === "grounding") {
          updateStreamingAssistant(assistantId, (m) => ({
            ...m,
            grounding: {
              grounded: event.data.grounded,
              max_score: event.data.max_score,
            },
          }));
        } else if (event.type === "turn_start" || event.type === "turn_end") {
          updateStreamingAssistant(assistantId, (m) => ({
            ...m,
            model: event.data.model ?? m.model,
            provider: event.data.provider ?? m.provider,
          }));
        } else if (event.type === "artifact") {
          if (event.data.content) {
            setActiveArtifact({
              id: event.data.id,
              session_id: sessionId,
              message_id: event.data.message_id,
              kind: event.data.kind,
              title: event.data.title,
              content: event.data.content,
              created_at: new Date().toISOString(),
            });
            setArtifactViewerOpen(true);
          }
          api.getArtifact(event.data.id).then((art) => {
            setActiveArtifact(art);
            setArtifactViewerOpen(true);
          }).catch(() => {});
        }
      };

      try {
        const summary = await streamChat(sessionId, text, {
          signal: controller.signal,
          onEvent,
          ...(skill ? { skill } : {}),
        });

        if (summary.stopReason === "error") {
          await finishTurn(
            sessionId,
            "error",
            summary.errorMessage ?? "The assistant failed to finish its reply.",
          );
        } else if (summary.stopReason === "aborted") {
          await finishTurn(sessionId, "stopped");
        } else {
          await finishTurn(sessionId, "done");
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          await finishTurn(sessionId, "stopped");
        } else if (e instanceof ApiError) {
          await finishTurn(sessionId, "error", e.message);
        } else {
          await finishTurn(
            sessionId,
            "error",
            "Something went wrong sending your message.",
          );
        }
      }
    },
    [finishTurn, updateStreamingAssistant],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleRetry = useCallback(() => {
    const prompt = lastUserPromptRef.current;
    if (prompt) void handleSend(prompt);
  }, [handleSend]);

  const handleEssay = useCallback(() => {
    if (!activeSessionIdRef.current || streaming) return;
    void handleSend(
      "Turn what we've been discussing into a Ship 30 for 30 essay (~1,250 words).",
      "ship30_essay",
    );
  }, [handleSend, streaming]);

  const handleArtifact = useCallback((text: string) => {
    if (!activeSessionIdRef.current || streaming) return;
    void handleSend(text, "artifact");
  }, [handleSend, streaming]);

  const handleDismissError = useCallback(() => {
    setError(null);
  }, []);

  const disabled = !activeSessionId;

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeTitle =
    activeSession?.title ??
    activeSession?.user_label ??
    (messages.length > 0 ? "Conversation" : "New conversation");

  return (
    <div className="app-shell">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={selectSession}
        onCreate={() => void createSession()}
        onDelete={deleteSession}
        onRename={renameSession}
        loading={loadingSessions}
        theme={theme}
        onThemeChange={setTheme}
        isOpenOnMobile={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      <div className="app-main">
        <StatusBar
          health={health}
          backendDown={backendStatus === "down"}
          activeTitle={activeTitle}
          onToggleSidebar={() => setMobileSidebarOpen((prev) => !prev)}
          onCreateSession={() => void createSession()}
          hasArtifact={Boolean(activeArtifact)}
          onOpenArtifact={() => setArtifactViewerOpen(true)}
        />
        <div className="app-main__content">
          <ChatPanel
            messages={messages}
            streaming={streaming}
            onSend={(text) => void handleSend(text)}
            onEssay={handleEssay}
            onArtifact={handleArtifact}
            onStop={handleStop}
            error={error}
            onRetry={handleRetry}
            onDismissError={handleDismissError}
            disabled={disabled}
            maxLength={config?.chat_max_message_chars ?? MESSAGE_CHAR_LIMIT_DEFAULT}
            inputRef={inputRef}
            lastUserPromptRef={lastUserPromptRef}
          />
          {activeArtifact && !artifactViewerOpen && (
            <button className="open-artifact-btn" onClick={() => setArtifactViewerOpen(true)}>
              View Artifact ({activeArtifact.kind})
            </button>
          )}
          {artifactViewerOpen && (
            <ArtifactViewer
              artifact={activeArtifact}
              onClose={() => setArtifactViewerOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}