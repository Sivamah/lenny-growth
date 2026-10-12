import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { screen, within } from "@testing-library/dom";
import { MessageBubble } from "./MessageBubble";
import type { ClientMessage } from "../types";

function message(overrides: Partial<ClientMessage> = {}): ClientMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Here is the answer.",
    provider: "ollama",
    skill: null,
    citations: [],
    model: "ollama/llama3.2:3b",
    grounding: null,
    token_usage: null,
    created_at: "2026-10-10T00:00:00Z",
    ...overrides,
  };
}

describe("MessageBubble", () => {
  it("renders a grounded answer with a positive grounding tag", () => {
    render(<MessageBubble message={message({ grounding: { grounded: true, max_score: 0.7 } })} />);
    expect(screen.getByText(/Grounded in transcripts/i)).toBeInTheDocument();
  });

  it("marks an answer without sufficient evidence as ungrounded and suppresses citations", () => {
    render(
      <MessageBubble
        message={message({
          grounding: { grounded: false, max_score: 0.2 },
          citations: [
            { guest: "Amol Avasare", episode: "Anthropic", timestamp: "00:10", url: null, snippet: "unrelated", score: 0.2 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/No supporting evidence found/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Sources")).not.toBeInTheDocument();
  });

  it("renders citations with episode, guest, timestamp and an optional url link", () => {
    render(
      <MessageBubble
        message={message({
          citations: [
            { guest: "Jason Lemkin", episode: "SaaStr", timestamp: "01:26:30", url: "https://lennysnewsletter.com/p/a", snippet: "quote here", score: 0.6 },
            { guest: "Elena Verna", episode: "EV4", timestamp: "00:12", url: null, snippet: null, score: 0.55 },
          ],
        })}
      />,
    );
    const citations = screen.getByLabelText("Sources");
    expect(within(citations).getByText("Jason Lemkin")).toBeInTheDocument();
    expect(within(citations).getByText("SaaStr")).toBeInTheDocument();
    expect(within(citations).getByText(/01:26:30/)).toBeInTheDocument();
    const link = within(citations).getByRole("link", { name: /Jason Lemkin/ });
    expect(link).toHaveAttribute("href", "https://lennysnewsletter.com/p/a");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("never fabricates a link when the citation has no url", () => {
    render(
      <MessageBubble
        message={message({
          citations: [{ guest: "Elena Verna", episode: "EV4", timestamp: "00:12", url: null, snippet: null, score: 0.55 }],
        })}
      />,
    );
    const citations = screen.getByLabelText("Sources");
    expect(within(citations).queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders user messages as plain text without grounding or sources", () => {
    render(<MessageBubble message={message({ role: "user", content: "What is retention?" })} />);
    expect(screen.getByText("What is retention?")).toBeInTheDocument();
    expect(screen.queryByText(/Grounded in transcripts/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sources")).not.toBeInTheDocument();
  });

  it("does not render a grounding tag before grounding is reported", () => {
    render(<MessageBubble message={message({ grounding: null, status: "streaming" })} />);
    expect(screen.queryByText(/Grounded in transcripts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No supporting evidence/i)).not.toBeInTheDocument();
    expect(screen.getByText("typing…")).toBeInTheDocument();
  });
});