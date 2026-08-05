import { useState } from "react";
import { Check, Copy, Terminal, Wrench } from "lucide-react";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./ui";
import { cn } from "../lib/cn";
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

  const isUser = message.role === "user";

  if (message.role === "tool") {
    return (
      <div className="flex max-w-[85%] flex-col gap-1.5 self-start">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-info">
          <Terminal size={11} />
          tool result
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-info/20 bg-black/30 px-3.5 py-3 font-mono text-xs text-text">
          {message.content}
        </pre>
      </div>
    );
  }

  return (
    <div className={cn("group flex max-w-[75%] flex-col gap-1.5", isUser ? "self-end items-end" : "self-start items-start")}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{message.role}</div>

      {message.toolCalls?.length ? (
        <div className="flex flex-col gap-1.5">
          {message.toolCalls.map((call, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-lg border border-warning/25 bg-warning-dim px-3 py-2 font-mono text-xs text-warning"
            >
              <Wrench size={12} />
              {call.name}({JSON.stringify(call.arguments)})
            </div>
          ))}
        </div>
      ) : (
        <div
          className={cn(
            "rounded-2xl border px-4 py-3 text-sm leading-relaxed",
            isUser ? "border-border bg-card text-text" : "border-primary/15 bg-surface-2 text-text",
          )}
        >
          <Markdown content={message.content} />
          {message.streaming && <StreamingCursor />}
        </div>
      )}

      {message.error && <p className="px-1 text-xs text-critical">{message.error}</p>}
      {message.cancelled && !message.error && <p className="px-1 text-xs italic text-muted">Cancelled</p>}

      {!message.streaming && message.content && !message.toolCalls?.length && (
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-1 text-[11px] text-muted opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
