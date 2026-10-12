import { Type } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../config.ts";
import { retrieve, RetrievalError, type RetrievalResult } from "../retrieval.ts";

export const SEARCH_TRANSCRIPTS_TOOL_NAME = "search_transcripts";

export interface SearchTranscriptsDetails {
  query: string;
  source: RetrievalResult["source"];
  grounded?: boolean;
  max_score?: number;
  returned?: number;
  error?: string;
}

export function createSearchTranscriptsTool(
  cfg: AgentConfig,
): ToolDefinition<ReturnType<typeof searchParameters>, SearchTranscriptsDetails> {
  const tool = defineTool({
    name: SEARCH_TRANSCRIPTS_TOOL_NAME,
    label: "Search Transcripts",
    description:
      "Search Lenny's Podcast transcripts and return the most relevant teaching chunks with episode, guest, timestamp, and source URL.",
    promptSnippet: "Search Lenny's Podcast transcripts for relevant teaching chunks",
    promptGuidelines: [
      "Use search_transcripts whenever the user asks what the podcast says about a topic.",
      "Cite the episode and guest returned by search_transcripts in your answer.",
      "If grounded is false, the transcripts likely do not cover the topic: say so clearly and do not invent citations or answers.",
    ],
    parameters: searchParameters(),
    execute: async (
      _toolCallId: string,
      params: { query: string; top_k?: number },
    ): Promise<AgentToolResult<SearchTranscriptsDetails>> => {
      const requested = typeof params.top_k === "number" ? params.top_k : cfg.retrieval.topK;
      const topK = Math.max(1, Math.min(20, Math.floor(requested)));
      try {
        const result = await retrieve(cfg, params.query, topK);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {
            query: result.query,
            source: result.source,
            grounded: result.grounded,
            max_score: result.max_score,
            returned: result.results.length,
          },
        };
      } catch (error) {
        const message =
          error instanceof RetrievalError
            ? error.message
            : `Retrieval failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, query: params.query, source: "fastapi" }),
            },
          ],
          details: { query: params.query, source: "fastapi", error: message },
          isError: true,
        };
      }
    },
  });
  return tool;
}

function searchParameters() {
  return Type.Object({
    query: Type.String({ description: "Natural-language search query" }),
    top_k: Type.Optional(
      Type.Number({ description: "Maximum results to return", default: 5 }),
    ),
  });
}
