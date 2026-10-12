import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject } from "react";

interface Props {
  streaming: boolean;
  disabled: boolean;
  maxLength: number;
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
  lastUserPromptRef?: MutableRefObject<string | null>;
  /** Fired with trimmed text when the user submits. */
  onSend: (text: string) => void;
  /** Fired when the user requests a Ship 30 essay (uses the skill pipeline). */
  onEssay: () => void;
  /** Fired when the user requests an Artifact with a custom instruction. */
  onArtifact: (instruction: string) => void;
  /** Fired when the user clicks Stop during a streaming turn. */
  onStop: () => void;
  /** Preset text — used when an empty-state example is clicked. */
  prefill?: string;
  onPrefillConsumed?: () => void;
}

export function Composer({
  streaming,
  disabled,
  maxLength,
  inputRef: externalRef,
  lastUserPromptRef,
  onSend,
  onEssay,
  onArtifact,
  onStop,
  prefill,
  onPrefillConsumed,
}: Props) {
  const [draft, setDraft] = useState(prefill ?? "");
  const [artifactMode, setArtifactMode] = useState(false);
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = externalRef ?? internalRef;

  // Consume prefill exactly once
  const prevPrefill = useRef<string | undefined>(undefined);
  if (prefill !== prevPrefill.current) {
    prevPrefill.current = prefill;
    if (prefill !== undefined) {
      setDraft(prefill);
      onPrefillConsumed?.();
    }
  }

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || streaming || disabled) return;
    if (lastUserPromptRef) lastUserPromptRef.current = text;
    setDraft("");
    if (artifactMode) {
      setArtifactMode(false);
      onArtifact(text);
    } else {
      onSend(text);
    }
  }, [draft, streaming, disabled, artifactMode, lastUserPromptRef, onSend, onArtifact]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && artifactMode) {
      setArtifactMode(false);
    }
  };

  const charCount = draft.length;
  const nearLimit = charCount >= Math.floor(maxLength * 0.85);

  return (
    <footer className="composer" role="region" aria-label="Message composer">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="composer__form"
      >
        <div className={`composer__inner ${artifactMode ? "composer__inner--artifact-mode" : ""}`}>
          <label htmlFor="chat-composer-input" className="sr-only">
            Message
          </label>
          <textarea
            ref={textareaRef}
            id="chat-composer-input"
            className="composer__textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              artifactMode
                ? "Describe the artifact you want to create..."
                : "Ask a product or growth question…"
            }
            rows={2}
            maxLength={maxLength}
            disabled={disabled}
            aria-describedby="composer-hint"
          />

          <div className="composer__actions-bar">
            {/* Quick Skills / Modes */}
            <div className="composer__skills">
              <button
                type="button"
                className="composer__skill-btn composer__essay"
                onClick={onEssay}
                disabled={disabled || streaming}
                aria-label="Write a Ship 30 essay"
                title="Write a structured Ship 30 essay (~1,250 words) from context"
              >
                <span aria-hidden="true">✍️</span>
                <span>Essay</span>
              </button>

              {artifactMode ? (
                <button
                  type="button"
                  className="composer__skill-btn composer__artifact composer__artifact--active"
                  onClick={() => setArtifactMode(false)}
                  disabled={disabled || streaming}
                  aria-label="Cancel artifact mode"
                  title="Cancel Artifact Mode (Esc)"
                >
                  <span aria-hidden="true">✕</span>
                  <span>Cancel</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="composer__skill-btn composer__artifact"
                  onClick={() => setArtifactMode(true)}
                  disabled={disabled || streaming}
                  aria-label="Generate an artifact"
                  title="Generate a standalone interactive HTML or Markdown artifact"
                >
                  <span aria-hidden="true">📄</span>
                  <span>Artifact</span>
                </button>
              )}
            </div>

            {/* Right side controls: character count & submit / stop */}
            <div className="composer__controls">
              {nearLimit && (
                <span className="composer__count" aria-live="polite">
                  {charCount} / {maxLength}
                </span>
              )}

              {streaming ? (
                <button
                  type="button"
                  className="composer__stop"
                  onClick={onStop}
                  aria-label="Stop generation"
                  title="Stop generation (Esc)"
                >
                  <span className="composer__stop-icon" aria-hidden="true">■</span>
                  <span className="composer__stop-label">Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className="composer__send"
                  disabled={disabled || !draft.trim()}
                  aria-label="Send message"
                  title="Send message (Enter)"
                >
                  <span className="composer__send-icon" aria-hidden="true">↑</span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div id="composer-hint" className="composer__footer-hint">
          <span>Enter to send · Shift+Enter for new line</span>
          {artifactMode && (
            <span className="composer__mode-tag">
              ⚡ Artifact Generation Mode Active
            </span>
          )}
        </div>
      </form>
    </footer>
  );
}
