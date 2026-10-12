import type { AgentConfig } from "./config.ts";

export interface RetrievalChunk {
  chunk_id?: string;
  transcript_slug?: string;
  episode_title?: string;
  guest?: string;
  speaker?: string;
  timestamp?: string;
  source_url?: string;
  content: string;
  score?: number;
}

export interface RetrievalResult {
  query: string;
  grounded: boolean;
  max_score: number;
  results: RetrievalChunk[];
  /** "fastapi" = real HTTP endpoint, "mock" = local stub (FastAPI not available). */
  source: "fastapi" | "mock";
}

export class RetrievalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetrievalError";
  }
}

export const MOCK_MARKER = "[MOCK RETRIEVAL - NOT REAL TRANSCRIPTS]";

/** Deterministic stub used when the FastAPI retrieval endpoint is unavailable. */
export function mockRetrieval(query: string, topK: number): RetrievalResult {
  const count = Math.max(1, Math.min(topK, 2));
  const results: RetrievalChunk[] = Array.from({ length: count }, (_, index) => ({
    chunk_id: `mock-${index + 1}`,
    transcript_slug: "mock-episode",
    episode_title: "Mock Episode (agent-service stub)",
    guest: "Mock Guest",
    timestamp: `00:0${index}:00`,
    source_url: "https://example.com/mock",
    content: `${MOCK_MARKER} Placeholder chunk ${index + 1} for query "${query}". This is not real transcript content.`,
    score: Number((0.9 - index * 0.1).toFixed(2)),
  }));
  return {
    query,
    // Mock results are never a real grounding signal, so grounded is always
    // false even though the placeholder chunks carry arbitrary scores.
    grounded: false,
    max_score: results[0]?.score ?? 0,
    results,
    source: "mock",
  };
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0] as AbortSignal;
  return AbortSignal.any(active);
}

/** Call the FastAPI internal retrieval endpoint (or the mock stub). */
export async function retrieve(
  cfg: AgentConfig,
  query: string,
  topK: number,
  signal?: AbortSignal,
): Promise<RetrievalResult> {
  if (cfg.retrieval.mock) return mockRetrieval(query, topK);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (cfg.retrieval.internalToken) {
    headers["X-Internal-Token"] = cfg.retrieval.internalToken;
  }

  const timeoutSignal = AbortSignal.timeout(cfg.retrieval.timeoutMs);
  const combined = combineSignals([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(cfg.retrieval.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, top_k: topK }),
      signal: combined,
    });
  } catch (error) {
    throw new RetrievalError(
      `Retrieval endpoint unreachable at ${cfg.retrieval.url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new RetrievalError(
      `Retrieval endpoint returned HTTP ${response.status} at ${cfg.retrieval.url}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
    );
  }

  const json = (await response.json()) as Partial<RetrievalResult>;
  const results = Array.isArray(json.results) ? json.results : [];
  const maxScore =
    typeof json.max_score === "number"
      ? json.max_score
      : Math.max(0, ...results.map((chunk) => chunk.score ?? 0));

  return {
    query,
    grounded: typeof json.grounded === "boolean" ? json.grounded : maxScore >= cfg.retrieval.minScore,
    max_score: maxScore,
    results,
    source: "fastapi",
  };
}
