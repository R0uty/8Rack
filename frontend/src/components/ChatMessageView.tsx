import { useState } from "react";
import { Markdown } from "./Markdown";
import type { ChatMessage } from "../types/chat";

interface ChatMessageViewProps {
  message: ChatMessage;
}

export function ChatMessageView({ message }: ChatMessageViewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (message.role === "tool") {
    return (
      <div className="chat-message chat-message--tool">
        <div className="chat-message__role">tool result</div>
        <pre className="chat-message__tool-result">{message.content}</pre>
      </div>
    );
  }

  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__role">{message.role}</div>
      {message.toolCalls?.length ? (
        <div className="chat-message__body chat-message__tool-calls">
          {message.toolCalls.map((call, i) => (
            <div key={i} className="chat-message__tool-call">
              called <code>{call.name}</code>({JSON.stringify(call.arguments)})
            </div>
          ))}
        </div>
      ) : (
        <div className="chat-message__body">
          <Markdown content={message.content} />
          {message.streaming && <span className="chat-message__cursor" />}
        </div>
      )}
      {message.error && <p className="chat-message__error">{message.error}</p>}
      {message.cancelled && !message.error && <p className="chat-message__cancelled">Cancelled</p>}
      {!message.streaming && message.content && !message.toolCalls?.length && (
        <button type="button" className="chat-message__copy" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
