import { useLayoutEffect, useRef } from "react";
import type { UIEvent } from "react";
import type { ClientMessage } from "../types";
import { MessageBubble } from "./MessageBubble";
import { EmptyState } from "./EmptyState";

interface Props {
  messages: ClientMessage[];
  streaming: boolean;
  onExample?: (text: string) => void;
}

export function MessageList({ messages, streaming, onExample }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Keep view pinned to the latest message only while the user is already
  // near the bottom, so scrolling up to re-read never fights the stream.
  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, streaming]);

  return (
    <div
      ref={listRef}
      className="message-list"
      onScroll={handleScroll}
      role="list"
      aria-label="Conversation messages"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions"
    >
      {messages.length === 0 ? (
        <EmptyState onExample={onExample} />
      ) : (
        messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))
      )}
    </div>
  );
}
