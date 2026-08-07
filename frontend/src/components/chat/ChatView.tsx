import { Compass, MessageSquarePlus } from "lucide-react";
import type { AgentWithStatus } from "../../types/agent";
import type { OllamaModel } from "../../types/ollama";
import type { Settings } from "../../types/settings";
import type { SessionMeta, UseSessions } from "../../hooks/useSessions";
import { useProjects } from "../../hooks/useProjects";
import { AgentNetwork } from "./AgentNetwork";
import { ChatSessionPanel } from "./ChatSessionPanel";
import { SessionTabs } from "../layout/SessionTabs";
import { Button } from "../ui";
import { cn } from "../../lib/cn";

interface ChatViewProps {
  agents: AgentWithStatus[];
  models: OllamaModel[];
  settings: Settings;
  /** The sidebar's manually-picked model, used only for starting a fresh no-agent chat. */
  manualModel: string | null;
  sessions: UseSessions;
  /** Clicking a task-session node on the map needs to switch the app into the Workbench view too,
   * which this view has no say over - the parent (App.tsx) owns that. */
  onFocusTaskSession: (sessionId: string) => void;
}

/** The Chat nav view: a tab strip of open chat sessions (see hooks/useSessions.ts) plus a
 * permanent Home tab showing the live agent/session network map. */
export function ChatView({ agents, models, settings, manualModel, sessions, onFocusTaskSession }: ChatViewProps) {
  const {
    sessions: allSessions,
    chatSessions,
    activeChatId,
    statuses,
    openChatSession,
    closeSession,
    setActiveChat,
    setSessionModel,
    setSessionProject,
    setSessionTaskId,
    reportStatus,
  } = sessions;
  // Owned once here (rather than inside each ChatSessionPanel) so every open tab shares the same
  // fetched list instead of re-requesting it independently - matches OrchestratorWorkbench.tsx.
  const { projects } = useProjects();

  const handleSelectSession = (session: SessionMeta) => {
    if (session.kind === "chat") setActiveChat(session.id);
    else onFocusTaskSession(session.id);
  };

  return (
    <div className="flex h-full flex-col">
      <SessionTabs
        sessions={chatSessions}
        activeId={activeChatId}
        onSelect={setActiveChat}
        onClose={closeSession}
        agents={agents}
        statuses={statuses}
        homeIcon={Compass}
        homeLabel="Command Center"
      />

      <div className="min-h-0 flex-1 pt-4">
        <div className={cn("h-full", activeChatId !== null && "hidden")}>
          <div className="flex h-full flex-col items-center justify-center gap-6">
            <AgentNetwork
              agents={agents}
              sessions={allSessions}
              statuses={statuses}
              onSelectAgent={(agent) => openChatSession(agent.id, agent.model)}
              onSelectSession={handleSelectSession}
            />
            <Button
              variant="secondary"
              icon={MessageSquarePlus}
              disabled={!manualModel}
              onClick={() => manualModel && openChatSession(null, manualModel)}
            >
              {manualModel ? `Start a manual chat with ${manualModel}` : "No model available"}
            </Button>
          </div>
        </div>

        {chatSessions.map((session) => (
          <div key={session.id} className={cn("h-full", session.id !== activeChatId && "hidden")}>
            <ChatSessionPanel
              session={session}
              settings={settings}
              models={models}
              agentDefaultModel={agents.find((a) => a.id === session.agentId)?.model}
              agentName={agents.find((a) => a.id === session.agentId)?.name ?? "Agent"}
              projects={projects}
              onChangeModel={setSessionModel}
              onChangeProject={setSessionProject}
              onChangeTaskId={setSessionTaskId}
              reportStatus={reportStatus}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
