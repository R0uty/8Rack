import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppShell, CommandPalette, RightPanel, Sidebar, TopBar, type AppView } from "./components/layout";
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
  // undefined = editor closed, null = create mode, an agent = edit mode.
  const [editingAgent, setEditingAgent] = useState<AgentWithStatus | null | undefined>(undefined);

  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].name);
    }
  }, [models, selectedModel]);

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
    setActiveView("chat");
  };

  // A task-session node on the network map lives in the Chat view but represents Workbench work —
  // focusing it has to switch views too.
  const handleFocusTaskSession = (sessionId: string) => {
    sessions.setActiveTask(sessionId);
    setActiveView("workbench");
  };

  // The sidebar logo doubles as a "return to Command Center" button — the only way back to the
  // network map from Workbench, Plans, or a chat session tab without hunting for the Home tab.
  const handleGoHome = () => {
    setActiveView("chat");
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
            onChangeView={setActiveView}
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
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={activeView}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className="h-full"
            >
              {activeView === "chat" && (
                <ChatView
                  agents={agents}
                  models={models}
                  settings={settings}
                  manualModel={selectedModel}
                  sessions={sessions}
                  onFocusTaskSession={handleFocusTaskSession}
                />
              )}
              {activeView === "workbench" && (
                <OrchestratorWorkbench agents={agents} models={models} sessions={sessions} />
              )}
              {activeView === "plans" && <MultiAgentPlanner agents={agents} />}
              {activeView === "findings" && <FindingsView />}
            </motion.div>
          </AnimatePresence>
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
        onChangeView={setActiveView}
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
