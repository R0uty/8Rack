import { useEffect, useRef } from "react";
import { ChatMessageView } from "./ChatMessageView";
import type { ChatMessage } from "../types/chat";

interface ChatAreaProps {
  messages: ChatMessage[];
  onClear: () => void;
}

export function ChatArea({ messages, onClear }: ChatAreaProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="chat-area">
      <div className="chat-area__toolbar">
        <button type="button" onClick={onClear} disabled={messages.length === 0}>
          Clear Chat
        </button>
      </div>
      <div className="chat-area__messages">
        {messages.length === 0 && <p className="chat-area__placeholder">No messages yet</p>}
        {messages.map((message) => (
          <ChatMessageView key={message.id} message={message} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
