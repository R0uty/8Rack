import { useEffect, useMemo, useState } from "react";
import { AppShell, CommandPalette, RightPanel, Sidebar, TopBar, type AppView } from "./components/layout";
import { cn } from "./lib/cn";
import { ChatView } from "./components/chat/ChatView";
import { SettingsPanel } from "./components/SettingsPanel";
import { AgentEditor } from "./components/AgentEditor";
import { OrchestratorWorkbench } from "./components/OrchestratorWorkbench";
import { MultiAgentPlanner } from "./components/MultiAgentPlanner";
import { FindingsView } from "./components/FindingsView";
import { useModels } from "./hooks/useModels";
import { useAgents } from "./hooks/useAgents";
import { useTools } from "./hooks/useTools";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import { useSessions } from "./hooks/useSessions";
import type { AgentWithStatus } from "./types/agent";

function App() {
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels } = useModels();
  const {
    agents,
    warnings: agentWarnings,
    loading: agentsLoading,
    error: agentsError,
    refresh: refreshAgents,
    create: createAgent,
    update: updateAgent,
    remove: removeAgent,
  } = useAgents();
  // Tool list isn't project-scoped (only execution history is) - null just skips fetching
  // executions this hook would otherwise pull in for a project-scoped Execution Console.
  const { tools: execTools } = useTools(null);
  // The model for the *next* manual (no-agent) chat — each agent's own session carries its own
  // model instead, seeded from the agent's default at creation (see hooks/useSessions.ts).
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const { theme, toggle: toggleTheme } = useTheme();
  const sessions = useSessions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("chat");
  // Every view a user has ever switched to stays mounted forever after (see the `center` prop
  // below) - chat/task sessions live inside ChatView/OrchestratorWorkbench as plain React state
  // (useChat/useOrchestratorTask), most of it never persisted anywhere, so unmounting either view
  // on a nav switch would silently kill an in-flight stream or reset a task back to "Starting…".
  // Same "mount once, toggle visibility" pattern SessionTabs already uses for session tabs within
  // a view, just applied one level up. Views are lazily added on first visit rather than all
  // mounted upfront, so switching to a view you've never opened doesn't fire its data fetches for
  // nothing.
  const [visitedViews, setVisitedViews] = useState<Set<AppView>>(() => new Set(["chat"]));
  const changeView = (view: AppView) => {
    setActiveView(view);
    setVisitedViews((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  };
  // undefined = editor closed, null = create mode, an agent = edit mode.
  const [editingAgent, setEditingAgent] = useState<AgentWithStatus | null | undefined>(undefined);

  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].name);
    }
  }, [models, selectedModel]);

  // Deleting an agent otherwise left its session(s) dangling in sessionStorage forever (a closed
  // chat session in particular has no other eviction path - see hooks/useSessions.ts). Gated on
  // `!agentsLoading` so this never runs against the transient empty `agents` list before the very
  // first fetch resolves, which would wrongly prune every session on initial load.
  useEffect(() => {
    if (agentsLoading) return;
    sessions.pruneOrphanedSessions(new Set(agents.map((a) => a.id)));
    // sessions.pruneOrphanedSessions is a stable useCallback (empty deps) - only agents/agentsLoading
    // actually drive this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, agentsLoading]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const ollamaStatus = modelsError ? "unavailable" : modelsLoading ? "unknown" : "connected";

  const activeAgentIds = useMemo(
    () => new Set(sessions.sessions.map((s) => s.agentId).filter((id): id is string => id !== null)),
    [sessions.sessions],
  );

  // Clicking an agent (sidebar, network map, or command palette) always means "open/focus a chat
  // with it" and takes you to the Chat view, even from elsewhere — there's no more single global
  // "selected agent" the rest of the app depends on.
  const handleSelectAgent = (agent: AgentWithStatus) => {
    sessions.openChatSession(agent.id, agent.model);
    changeView("chat");
  };

  // A task-session node on the network map lives in the Chat view but represents Workbench work —
  // focusing it has to switch views too.
  const handleFocusTaskSession = (sessionId: string) => {
    sessions.setActiveTask(sessionId);
    changeView("workbench");
  };

  // The sidebar logo doubles as a "return to Command Center" button — the only way back to the
  // network map from Workbench, Plans, or a chat session tab without hunting for the Home tab.
  const handleGoHome = () => {
    changeView("chat");
    sessions.setActiveChat(null);
  };

  // What TopBar/RightPanel show as "the current agent/model" depends on which view (and which of
  // its tabs) is focused — there's no single global selection to read anymore.
  const activeSession =
    activeView === "chat"
      ? sessions.chatSessions.find((s) => s.id === sessions.activeChatId)
      : activeView === "workbench"
        ? sessions.taskSessions.find((s) => s.id === sessions.activeTaskId)
        : undefined;
  const activeSessionAgent = activeSession?.agentId ? agents.find((a) => a.id === activeSession.agentId) ?? null : null;
  const activeSessionModel = activeSession?.model ?? (activeView === "chat" ? selectedModel : null);

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            activeView={activeView}
            onChangeView={changeView}
            onGoHome={handleGoHome}
            models={models}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            onRefreshModels={refreshModels}
            agents={agents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            agentWarnings={agentWarnings}
            activeAgentIds={activeAgentIds}
            onSelectAgent={handleSelectAgent}
            onRefreshAgents={refreshAgents}
            onCreateAgent={() => setEditingAgent(null)}
            onEditAgent={setEditingAgent}
            ollamaStatus={ollamaStatus}
          />
        }
        topBar={
          <TopBar
            activeView={activeView}
            agentName={activeSessionAgent?.name ?? null}
            selectedModel={activeSessionModel}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
        }
        center={
          <>
            {visitedViews.has("chat") && (
              <div className={cn("h-full", activeView !== "chat" && "hidden")}>
                <ChatView
                  agents={agents}
                  models={models}
                  settings={settings}
                  manualModel={selectedModel}
                  sessions={sessions}
                  onFocusTaskSession={handleFocusTaskSession}
                />
              </div>
            )}
            {visitedViews.has("workbench") && (
              <div className={cn("h-full", activeView !== "workbench" && "hidden")}>
                <OrchestratorWorkbench agents={agents} models={models} sessions={sessions} />
              </div>
            )}
            {visitedViews.has("plans") && (
              <div className={cn("h-full", activeView !== "plans" && "hidden")}>
                <MultiAgentPlanner agents={agents} />
              </div>
            )}
            {visitedViews.has("findings") && (
              <div className={cn("h-full", activeView !== "findings" && "hidden")}>
                <FindingsView />
              </div>
            )}
          </>
        }
        rightPanel={
          activeView === "chat" ? (
            <RightPanel
              activeAgent={activeSessionAgent}
              activeModel={activeSessionModel}
              sessions={sessions.sessions}
            />
          ) : undefined
        }
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onReset={resetSettings}
        onClose={() => setSettingsOpen(false)}
      />

      <AgentEditor
        open={editingAgent !== undefined}
        agent={editingAgent ?? null}
        models={models}
        execTools={execTools}
        onSave={(id, agent) => (id ? updateAgent(id, agent) : createAgent(agent))}
        onDelete={removeAgent}
        onClose={() => setEditingAgent(undefined)}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onChangeView={changeView}
        agents={agents}
        onSelectAgent={handleSelectAgent}
        models={models}
        onSelectModel={setSelectedModel}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
      />
    </>
  );
}

export default App;
