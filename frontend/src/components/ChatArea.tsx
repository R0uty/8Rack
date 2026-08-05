import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { ChatMessageView } from "./ChatMessageView";
import { AgentNetwork } from "./chat/AgentNetwork";
import { Button } from "./ui";
import type { ChatMessage } from "../types/chat";
import type { AgentWithStatus } from "../types/agent";

interface ChatAreaProps {
  messages: ChatMessage[];
  onClear: () => void;
  agents: AgentWithStatus[];
  selectedAgentId: string | null;
  onSelectAgent: (agent: AgentWithStatus) => void;
}

export function ChatArea({ messages, onClear, agents, selectedAgentId, onSelectAgent }: ChatAreaProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6">
        <AgentNetwork agents={agents} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} />
        <p className="max-w-sm text-center text-sm text-muted">
          Select an agent above or just start typing below to chat with the current model.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex justify-end">
        <Button variant="ghost" size="sm" icon={Trash2} onClick={onClear} disabled={messages.length === 0}>
          Clear Chat
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-2">
        {messages.map((message) => (
          <ChatMessageView key={message.id} message={message} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
