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

  let groundedState: "grounded" | "ungrounded" | "unknown" = "unknown";
  if (message.grounding) {
    groundedState = message.grounding.grounded ? "grounded" : "ungrounded";
  }

  const best = primaryScore(message.citations);

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
              }}
            >
              {message.content || (message.status === "streaming" ? "" : "…")}
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
        <Citations citations={message.citations} />
      )}
    </article>
  );
}