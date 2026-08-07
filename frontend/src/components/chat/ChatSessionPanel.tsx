import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Cpu, FolderKanban, RotateCcw } from "lucide-react";
import { useChat } from "../../hooks/useChat";
import type { SessionMeta } from "../../hooks/useSessions";
import { ChatTaskPanel } from "./ChatTaskPanel";
import { IconButton, type Tone } from "../ui";
import { ChatArea } from "../ChatArea";
import { PromptInput } from "../PromptInput";
import type { Settings } from "../../types/settings";
import type { ChatOptions } from "../../types/chat";
import type { OllamaModel } from "../../types/ollama";
import type { Project } from "../../types/project";

interface ChatSessionPanelProps {
  session: SessionMeta;
  settings: Settings;
  models: OllamaModel[];
  /** The agent's own default model, for the "reset to default" affordance — undefined for a
   * manual (no-agent) session, which has no default to reset to. */
  agentDefaultModel: string | undefined;
  agentName: string;
  /** Only rendered as a selector for agent-backed sessions (session.agentId !== null) - see
   * hooks/useSessions.ts#SessionMeta.projectId. */
  projects: Project[];
  onChangeModel: (sessionId: string, model: string) => void;
  onChangeProject: (sessionId: string, projectId: string | undefined) => void;
  onChangeTaskId: (sessionId: string, taskId: string) => void;
  reportStatus: (id: string, tone: Tone) => void;
}

/**
 * One agent (or manual) chat conversation - a thin wrapper around the existing ChatArea/
 * PromptInput pair, parameterized by a session's own agentId/model instead of a single global
 * selection. Mounted once per open chat session (see hooks/useSessions.ts) and kept mounted while
 * inactive so its `useChat` instance keeps its state (and any in-flight stream) alive in the
 * background - this is what makes a second agent's chat genuinely independent of this one.
 *
 * Picking a project (agent-backed sessions only) switches the body below the shared header over to
 * ChatTaskPanel instead - see hooks/useSessions.ts#SessionMeta.projectId.
 */
export function ChatSessionPanel({
  session,
  settings,
  models,
  agentDefaultModel,
  agentName,
  projects,
  onChangeModel,
  onChangeProject,
  onChangeTaskId,
  reportStatus,
}: ChatSessionPanelProps) {
  const { messages, sending, sendMessage, cancel, clear } = useChat(session.id);
  const [prompt, setPrompt] = useState("");

  // Once a project is picked, ChatTaskPanel owns status reporting for this session instead (it
  // tracks the real OrchestratorTask state, not just whether a plain stream is in flight).
  useEffect(() => {
    if (!session.projectId) reportStatus(session.id, sending ? "info" : "neutral");
  }, [sending, session.id, session.projectId, reportStatus]);

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
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
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

        {session.agentId !== null && (
          <>
            <FolderKanban size={12} className="ml-2" />
            <span>Project</span>
            <div className="relative">
              <select
                value={session.projectId ?? ""}
                onChange={(e) => onChangeProject(session.id, e.target.value || undefined)}
                title="Pick a project to let this agent request tools (e.g. running commands) with your approval."
                className="appearance-none rounded-md border border-border bg-surface-2 py-1 pl-2 pr-6 text-[11px] text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <option value="">No project (chat only)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2" />
            </div>
            {session.projectId && (
              <span className="rounded-full bg-primary-dim px-1.5 py-0.5 text-[10px] text-primary">tools enabled</span>
            )}
          </>
        )}
      </div>

      {session.projectId ? (
        <>
          {messages.length > 0 && (
            <div className="flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                Tools enabled — this starts a fresh tool-enabled thread. The {messages.length} earlier
                message{messages.length === 1 ? "" : "s"} in this session's plain chat aren't shown here and
                aren't seen by {agentName}; switch Project back to "No project" to see them again.
              </span>
            </div>
          )}
          <ChatTaskPanel
            session={session}
            agentName={agentName}
            reportStatus={reportStatus}
            onChangeTaskId={onChangeTaskId}
          />
        </>
      ) : (
        <>
          <ChatArea messages={messages} onClear={clear} />
          <PromptInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={handleSubmit}
            onCancel={cancel}
            sending={sending}
            disabled={!session.model}
          />
        </>
      )}
    </div>
  );
}
