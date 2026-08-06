import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { ChatMessageView } from "./ChatMessageView";
import { Button } from "./ui";
import type { ChatMessage } from "../types/chat";

interface ChatAreaProps {
  messages: ChatMessage[];
  onClear: () => void;
}

/** One session's message transcript. The empty (no-agent, network-graph) landing state lives one
 * level up, in the Chat view's Home tab - by the time a ChatArea is mounted, it belongs to a real
 * open session, so an empty list here just means "nothing sent in this session yet". */
export function ChatArea({ messages, onClear }: ChatAreaProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex justify-end">
        <Button variant="ghost" size="sm" icon={Trash2} onClick={onClear} disabled={messages.length === 0}>
          Clear Chat
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-2">
        {messages.length === 0 && <p className="text-sm text-muted">No messages yet — say something below.</p>}
        {messages.map((message) => (
          <ChatMessageView key={message.id} message={message} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
