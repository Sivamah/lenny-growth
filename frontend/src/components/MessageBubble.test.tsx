import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { screen, within } from "@testing-library/dom";
import { MessageBubble, linkifyCitationMarkers } from "./MessageBubble";
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

  it("renders inline citation markers [1] as interactive buttons matching source cards", () => {
    render(
      <MessageBubble
        message={message({
          content: "Focus on a specific customer segment first [1].",
          grounding: { grounded: true, max_score: 0.8 },
          citations: [
            { index: 1, guest: "Jason Cohen", episode: "WPEngine Story", timestamp: "00:15:30", url: "https://example.com/jc", snippet: "Find a narrow niche.", score: 0.8 },
          ],
        })}
      />,
    );

    const btn = screen.getByRole("button", { name: /Jump to source citation \[1\]/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass("citation-ref-btn");

    // Click triggers scroll / highlight
    fireEvent.click(btn);
    const sourceCard = document.getElementById("source-m1-1");
    expect(sourceCard).toBeInTheDocument();
    expect(sourceCard).toHaveClass("is-highlighted");
  });

  it("supports multiple inline citation markers like [1, 2] in the answer", () => {
    render(
      <MessageBubble
        message={message({
          content: "Both pricing [1] and distribution [2] are critical.",
          grounding: { grounded: true, max_score: 0.85 },
          citations: [
            { index: 1, guest: "Jason Cohen", episode: "Pricing 101", timestamp: "00:05", url: null, snippet: "Price higher.", score: 0.85 },
            { index: 2, guest: "Elena Verna", episode: "B2B PLG", timestamp: "00:12", url: null, snippet: "Build loops.", score: 0.75 },
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /Jump to source citation \[1\]/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jump to source citation \[2\]/i })).toBeInTheDocument();
  });

  it("handles missing speaker and timestamp cleanly without crashing or fabricating info", () => {
    render(
      <MessageBubble
        message={message({
          content: "Here is factual info [1].",
          grounding: { grounded: true, max_score: 0.6 },
          citations: [
            { index: 1, guest: null, speaker: null, episode: null, timestamp: null, url: null, snippet: "Some raw passage.", score: 0.6 },
          ],
        })}
      />,
    );

    const citations = screen.getByLabelText("Sources");
    expect(within(citations).getByText(/Lenny's Podcast Transcript/i)).toBeInTheDocument();
    expect(within(citations).queryByText(/⏱/)).not.toBeInTheDocument();
    expect(within(citations).queryByText(/Speaker:/)).not.toBeInTheDocument();
    expect(within(citations).getByText(/"Some raw passage."/)).toBeInTheDocument();
  });

  it("safely escapes malicious HTML in excerpts as plain text without DOM execution", () => {
    const maliciousExcerpt = `<script>alert('pwned')</script><img src=x onerror=alert('xss') />`;
    render(
      <MessageBubble
        message={message({
          content: "Notice the quote [1].",
          grounding: { grounded: true, max_score: 0.9 },
          citations: [
            { index: 1, guest: "Safe Guest", episode: "Security Ep", timestamp: "01:00", url: null, snippet: maliciousExcerpt, score: 0.9 },
          ],
        })}
      />,
    );

    // The script tag must NOT be parsed into the DOM as an HTML element
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByText((content) => content.includes("<script>alert('pwned')</script>"))).toBeInTheDocument();
  });

  it("blocks dangerous javascript: URLs in citations", () => {
    render(
      <MessageBubble
        message={message({
          content: "Testing unsafe protocol [1].",
          grounding: { grounded: true, max_score: 0.7 },
          citations: [
            { index: 1, guest: "Attacker", episode: "Exploit", timestamp: null, url: "javascript:alert(1)", snippet: "snippet", score: 0.7 },
          ],
        })}
      />,
    );

    const citations = screen.getByLabelText("Sources");
    // No link element should have been generated for javascript: URI
    expect(within(citations).queryByRole("link")).not.toBeInTheDocument();
  });

  it("toggles excerpt expansion for long passages", () => {
    const longExcerpt = "A".repeat(150);
    render(
      <MessageBubble
        message={message({
          content: "Read the full excerpt [1].",
          grounding: { grounded: true, max_score: 0.75 },
          citations: [
            { index: 1, guest: "Brian Balfour", episode: "Growth Loops", timestamp: "10:00", url: null, snippet: longExcerpt, score: 0.75 },
          ],
        })}
      />,
    );

    const toggleBtn = screen.getByRole("button", { name: /Expand excerpt for source \[1\]/i });
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn).toHaveTextContent("Show full excerpt ▾");

    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveTextContent("Show less ▴");
  });
});

describe("linkifyCitationMarkers helper", () => {
  it("converts standalone [1] and [2] in prose", () => {
    const text = "A claim here [1] and another [2].";
    expect(linkifyCitationMarkers(text)).toBe("A claim here [1](#source-1) and another [2](#source-2).");
  });

  it("converts comma-separated citations [1, 2]", () => {
    const text = "Shared insights [1, 2].";
    expect(linkifyCitationMarkers(text)).toBe("Shared insights [1](#source-1), [2](#source-2).");
  });

  it("leaves code blocks and inline code untouched", () => {
    const code = "Check `arr[1]` and:\n```\nconst x = matrix[1][2];\n```\nEnd.";
    expect(linkifyCitationMarkers(code)).toBe(code);
  });
});