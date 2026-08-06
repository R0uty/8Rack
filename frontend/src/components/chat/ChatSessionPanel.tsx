import { useEffect, useState } from "react";
import { ChevronDown, Cpu, RotateCcw } from "lucide-react";
import { useChat } from "../../hooks/useChat";
import type { SessionMeta } from "../../hooks/useSessions";
import { IconButton, type Tone } from "../ui";
import { ChatArea } from "../ChatArea";
import { PromptInput } from "../PromptInput";
import type { Settings } from "../../types/settings";
import type { ChatOptions } from "../../types/chat";
import type { OllamaModel } from "../../types/ollama";

interface ChatSessionPanelProps {
  session: SessionMeta;
  settings: Settings;
  models: OllamaModel[];
  /** The agent's own default model, for the "reset to default" affordance — undefined for a
   * manual (no-agent) session, which has no default to reset to. */
  agentDefaultModel: string | undefined;
  onChangeModel: (sessionId: string, model: string) => void;
  reportStatus: (id: string, tone: Tone) => void;
}

/**
 * One agent (or manual) chat conversation - a thin wrapper around the existing ChatArea/
 * PromptInput pair, parameterized by a session's own agentId/model instead of a single global
 * selection. Mounted once per open chat session (see hooks/useSessions.ts) and kept mounted while
 * inactive so its `useChat` instance keeps its state (and any in-flight stream) alive in the
 * background - this is what makes a second agent's chat genuinely independent of this one.
 */
export function ChatSessionPanel({
  session,
  settings,
  models,
  agentDefaultModel,
  onChangeModel,
  reportStatus,
}: ChatSessionPanelProps) {
  const { messages, sending, sendMessage, cancel, clear } = useChat(session.id);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    reportStatus(session.id, sending ? "info" : "neutral");
  }, [sending, session.id, reportStatus]);

  const handleSubmit = () => {
    const options: ChatOptions = {
      temperature: settings.temperature,
      top_p: settings.topP,
      ...(settings.maxTokens > 0 ? { num_predict: settings.maxTokens } : {}),
      ...(settings.contextSize > 0 ? { num_ctx: settings.contextSize } : {}),
    };

    sendMessage(prompt, {
      ...(session.agentId ? { agentId: session.agentId } : {}),
      model: session.model,
      options,
      keepAlive: settings.keepAlive,
    });
    setPrompt("");
  };

  const overridden = !!agentDefaultModel && session.model !== agentDefaultModel;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Cpu size={12} />
        <span>Model for this session</span>
        <div className="relative">
          <select
            value={session.model}
            onChange={(e) => onChangeModel(session.id, e.target.value)}
            className="appearance-none rounded-md border border-border bg-surface-2 py-1 pl-2 pr-6 font-mono text-[11px] text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <ChevronDown size={11} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2" />
        </div>
        {overridden && (
          <>
            <span className="rounded-full bg-warning-dim px-1.5 py-0.5 text-[10px] text-warning">overridden</span>
            <IconButton
              icon={RotateCcw}
              label="Reset to the agent's default model"
              size="sm"
              onClick={() => agentDefaultModel && onChangeModel(session.id, agentDefaultModel)}
            />
          </>
        )}
      </div>

      <ChatArea messages={messages} onClear={clear} />
      <PromptInput
        value={prompt}
        onChange={setPrompt}
        onSubmit={handleSubmit}
        onCancel={cancel}
        sending={sending}
        disabled={!session.model}
      />
    </div>
  );
}
