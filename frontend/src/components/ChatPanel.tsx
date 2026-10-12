import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ClientMessage } from "../types";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";

interface Props {
  messages: ClientMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onEssay: () => void;
  onArtifact: (text: string) => void;
  onStop: () => void;
  error: string | null;
  onRetry: () => void;
  onDismissError: () => void;
  disabled: boolean;
  maxLength: number;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  lastUserPromptRef: MutableRefObject<string | null>;
}

export function ChatPanel({
  messages,
  streaming,
  onSend,
  onEssay,
  onArtifact,
  onStop,
  error,
  onRetry,
  onDismissError,
  disabled,
  maxLength,
  inputRef,
  lastUserPromptRef,
}: Props) {
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const handleExample = (text: string) => {
    setPrefill(text);
    // Focus the composer after filling
    setTimeout(() => {
      (inputRef.current ?? composerRef.current)?.focus();
    }, 0);
  };

  return (
    <section className="chat-panel" aria-label="Conversation">
      <MessageList
        messages={messages}
        streaming={streaming}
        onExample={!disabled ? handleExample : undefined}
      />

      {error && (
        <ErrorBanner
          message={error}
          onRetry={lastUserPromptRef.current ? onRetry : undefined}
          onDismiss={onDismissError}
        />
      )}

      <Composer
        streaming={streaming}
        disabled={disabled}
        maxLength={maxLength}
        inputRef={inputRef}
        lastUserPromptRef={lastUserPromptRef}
        onSend={onSend}
        onEssay={onEssay}
        onArtifact={onArtifact}
        onStop={onStop}
        prefill={prefill}
        onPrefillConsumed={() => setPrefill(undefined)}
      />
    </section>
  );
}