import type {
  ApiErrorBody,
  ChatMessage,
  ClientConfig,
  HealthStatus,
  SessionSummary,
  ArtifactSummary,
  ArtifactRead,
} from "../types";

/**
 * Backend base URL for all API calls.
 *
 * Dev proxy mode: set VITE_API_BASE_URL="" (empty) in .env.local so that
 * fetch() uses relative URLs forwarded by Vite's /health /api /sessions proxy.
 *
 * Direct mode (default): leave unset → falls back to http://localhost:8000.
 */
function resolveBaseUrl(): string {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string> }).env;
  const viteBase = viteEnv?.VITE_API_BASE_URL;
  // An explicitly empty string means "use Vite proxy — relative URLs".
  if (typeof viteBase === "string") return viteBase;
  if (typeof process !== "undefined" && process.env?.VITE_API_BASE_URL !== undefined) {
    return process.env.VITE_API_BASE_URL ?? "";
  }
  return "http://localhost:8000";
}

export const BASE_URL = resolveBaseUrl();

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "Could not reach the backend API. Check that it is running.");
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error?.message ?? message;
    } catch {
      // response body wasn't JSON — keep the generic message
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthStatus>("/health"),

  config: () => request<ClientConfig>("/api/config"),

  createSession: (title?: string) =>
    request<SessionSummary>("/sessions", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),

  listSessions: () => request<SessionSummary[]>("/sessions"),

  renameSession: (sessionId: string, title: string) =>
    request<SessionSummary>(`/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  deleteSession: (sessionId: string) =>
    request<void>(`/sessions/${sessionId}`, { method: "DELETE" }),

  getMessages: (sessionId: string) =>
    request<ChatMessage[]>(`/sessions/${sessionId}/messages`),

  listArtifacts: (sessionId: string) =>
    request<ArtifactSummary[]>(`/sessions/${sessionId}/artifacts`),

  getArtifact: (artifactId: string) =>
    request<ArtifactRead>(`/artifacts/${artifactId}`),
};