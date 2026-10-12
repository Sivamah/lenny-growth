import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ClientMessage } from "../types";
import { Citations } from "./Citations";

function formatScore(score: number | null): string | null {
  if (score === null) return null;
  return score.toFixed(2);
}

function primaryScore(citations: ClientMessage["citations"]): number | null {
  if (citations.length === 0) return null;
  return citations.reduce<number | null>(
    (best, c) =>
      best === null ? c.score : c.score !== null && c.score > best ? c.score : best,
    null,
  );
}

/**
 * Transforms inline citation markers such as `[1]` or `[1, 2]` into markdown anchor links
 * e.g. `[1](#source-1)`, while strictly leaving code blocks and inline code intact.
 */
export function linkifyCitationMarkers(text: string): string {
  if (!text) return "";
  const parts = text.split(/(```[\s\S]*?```|`[^`]*`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`")) return part;
      // Handle comma-separated citations e.g. [1, 2]
      let transformed = part.replace(/\[(\d+(?:\s*,\s*\d+)+)\](?!\()/g, (_match, group: string) => {
        const nums = group.split(/\s*,\s*/);
        return nums.map((n) => `[${n}](#source-${n})`).join(", ");
      });
      // Handle single citations e.g. [1]
      transformed = transformed.replace(/\[(\d+)\](?!\()/g, "[$1](#source-$1)");
      return transformed;
    })
    .join("");
}

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const codeString = String(children).replace(/\n$/, "");
  const language = className ? className.replace(/language-/, "") : "";

  const handleCopy = () => {
    void navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-language">{language || "text"}</span>
        <button
          type="button"
          className="code-block-copy-btn"
          onClick={handleCopy}
          aria-label="Copy code to clipboard"
          title="Copy code"
        >
          {copied ? "✓ Copied" : "📋 Copy"}
        </button>
      </div>
      <pre className="code-block-pre">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function MessageBubble({ message }: { message: ClientMessage }) {
  const isUser = message.role === "user";
  const [activeSourceIndex, setActiveSourceIndex] = useState<number | null>(null);

  let groundedState: "grounded" | "ungrounded" | "unknown" = "unknown";
  if (message.grounding) {
    groundedState = message.grounding.grounded ? "grounded" : "ungrounded";
  }

  const best = primaryScore(message.citations);

  const handleJumpToSource = (index: number) => {
    setActiveSourceIndex(index);
    const elementId = `source-${message.id}-${index}`;
    const el = document.getElementById(elementId) || document.getElementById(`source-${index}`);
    if (el) {
      el.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      el.focus?.();
    }
  };

  const processedContent = !isUser && message.content
    ? linkifyCitationMarkers(message.content)
    : message.content;

  return (
    <article
      className={`message message--${message.role}`}
      data-status={message.status ?? "done"}
      role="listitem"
    >
      {/* Avatar and Meta row */}
      <div className="message__meta">
        <div className="message__avatar" aria-hidden="true">
          {isUser ? "👤" : "✨"}
        </div>
        <span className="message__role">{isUser ? "You" : "Assistant"}</span>
        {!isUser && message.provider && (
          <span className="badge badge--provider">{message.provider}</span>
        )}
        {!isUser && message.model && (
          <span className="badge badge--model">{message.model}</span>
        )}
        {!isUser && message.skill === "ship30_essay" && (
          <span className="badge badge--skill">✍️ Ship 30 essay</span>
        )}
        {!isUser && message.status === "streaming" && (
          <span className="badge badge--live" role="status" aria-label="Streaming response">
            typing…
          </span>
        )}
        {message.status === "stopped" && (
          <span className="badge badge--stopped">stopped</span>
        )}
        {message.status === "error" && (
          <span className="badge badge--risk">failed</span>
        )}
      </div>

      {/* Content bubble */}
      {message.status === "streaming" && !message.content ? (
        <div className="typing-indicator" aria-label="Assistant is typing">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      ) : (
        <div className="message__content">
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ inline, className, children, ...props }: any) {
                  if (inline) {
                    return (
                      <code className="inline-code" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return <CodeBlock className={className}>{children}</CodeBlock>;
                },
                a({ href, children, ...props }: any) {
                  if (href && href.startsWith("#source-")) {
                    const rawIdx = href.replace("#source-", "");
                    const idxNum = parseInt(rawIdx, 10);
                    return (
                      <button
                        type="button"
                        className="citation-ref-btn"
                        data-source-index={rawIdx}
                        onClick={(e) => {
                          e.preventDefault();
                          handleJumpToSource(idxNum);
                        }}
                        aria-label={`Jump to source citation [${children}]`}
                        title={`View source [${children}]`}
                      >
                        [{children}]
                      </button>
                    );
                  }
                  const hrefStr = String(href || "");
                  const isSafe = /^https?:\/\//i.test(hrefStr);
                  return (
                    <a
                      href={isSafe ? hrefStr : "#"}
                      target={isSafe ? "_blank" : undefined}
                      rel={isSafe ? "noopener noreferrer" : undefined}
                      {...props}
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {processedContent || (message.status === "streaming" ? "" : "…")}
            </ReactMarkdown>
          )}
        </div>
      )}

      {/* Grounding tag */}
      {!isUser && groundedState !== "unknown" && (
        <div
          className={`grounding-tag grounding-tag--${groundedState}`}
          role="status"
        >
          <span className="grounding-tag__dot" aria-hidden="true" />
          {groundedState === "grounded" ? (
            <>
              Grounded in transcripts
              {best !== null && (
                <span className="grounding-tag__score">
                  · best {formatScore(best)}
                </span>
              )}
            </>
          ) : (
            "No supporting evidence found in the transcripts"
          )}
        </div>
      )}

      {/* Citations - only rendered when grounded and present */}
      {!isUser && groundedState !== "ungrounded" && message.citations.length > 0 && (
        <Citations
          citations={message.citations}
          messageId={message.id}
          activeSourceIndex={activeSourceIndex}
        />
      )}
    </article>
  );
}