import { useEffect, useState } from "react";
import { AppShell, CommandPalette, Sidebar, TopBar, type AppView } from "./components/layout";
import { cn } from "./lib/cn";
import { SettingsPanel } from "./components/SettingsPanel";
import { AgentEditor } from "./components/AgentEditor";
import { FindingsView } from "./components/FindingsView";
import { FactoryDashboard } from "./components/FactoryDashboard";
import { MissionsView } from "./components/MissionsView";
import { AssetsView } from "./components/AssetsView";
import { WorkOrdersView } from "./components/WorkOrdersView";
import { ReportsView } from "./components/ReportsView";
import { AgentsView } from "./components/AgentsView";
import { ToolsView } from "./components/ToolsView";
import { useModels } from "./hooks/useModels";
import { useAgents } from "./hooks/useAgents";
import { useTools } from "./hooks/useTools";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import type { AgentWithStatus } from "./types/agent";

function App() {
  const { models, loading: modelsLoading, error: modelsError } = useModels();
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
  // Tool list isn't mission-scoped (only execution history is) - null just skips fetching
  // executions this hook would otherwise pull in, since App.tsx only needs it for AgentEditor's
  // tool-access preview.
  const { tools: execTools } = useTools(null);
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const { theme, toggle: toggleTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("factory");
  // Every view a user has ever switched to stays mounted forever after (see the `center` prop
  // below) - a view's own React state (e.g. a mission selection, an in-flight NDJSON stream) would
  // otherwise reset on every nav switch. Views are lazily added on first visit rather than all
  // mounted upfront, so switching to a view you've never opened doesn't fire its data fetches for
  // nothing.
  const [visitedViews, setVisitedViews] = useState<Set<AppView>>(() => new Set(["factory"]));
  const changeView = (view: AppView) => {
    setActiveView(view);
    setVisitedViews((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  };
  // undefined = editor closed, null = create mode, an agent = edit mode.
  const [editingAgent, setEditingAgent] = useState<AgentWithStatus | null | undefined>(undefined);

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

  // Clicking an agent (sidebar or command palette) opens its editor - there's no separate "chat
  // with" concept any more now that Chat is gone.
  const handleSelectAgent = (agent: AgentWithStatus) => {
    setEditingAgent(agent);
  };

  const handleGoHome = () => changeView("factory");

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            activeView={activeView}
            onChangeView={changeView}
            onGoHome={handleGoHome}
            agents={agents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            agentWarnings={agentWarnings}
            onSelectAgent={handleSelectAgent}
            onRefreshAgents={refreshAgents}
            onCreateAgent={() => setEditingAgent(null)}
            ollamaStatus={ollamaStatus}
          />
        }
        topBar={
          <TopBar
            activeView={activeView}
            agentName={null}
            selectedModel={null}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
        }
        center={
          <>
            {visitedViews.has("factory") && (
              <div className={cn("h-full", activeView !== "factory" && "hidden")}>
                <FactoryDashboard agents={agents} />
              </div>
            )}
            {visitedViews.has("missions") && (
              <div className={cn("h-full", activeView !== "missions" && "hidden")}>
                <MissionsView onOpenFactory={() => changeView("factory")} />
              </div>
            )}
            {visitedViews.has("assets") && (
              <div className={cn("h-full", activeView !== "assets" && "hidden")}>
                <AssetsView />
              </div>
            )}
            {visitedViews.has("workorders") && (
              <div className={cn("h-full", activeView !== "workorders" && "hidden")}>
                <WorkOrdersView />
              </div>
            )}
            {visitedViews.has("findings") && (
              <div className={cn("h-full", activeView !== "findings" && "hidden")}>
                <FindingsView />
              </div>
            )}
            {visitedViews.has("reports") && (
              <div className={cn("h-full", activeView !== "reports" && "hidden")}>
                <ReportsView />
              </div>
            )}
            {visitedViews.has("agents") && (
              <div className={cn("h-full", activeView !== "agents" && "hidden")}>
                <AgentsView
                  agents={agents}
                  loading={agentsLoading}
                  error={agentsError}
                  warnings={agentWarnings}
                  execTools={execTools}
                  onRefresh={refreshAgents}
                  onCreateAgent={() => setEditingAgent(null)}
                  onEditAgent={setEditingAgent}
                />
              </div>
            )}
            {visitedViews.has("tools") && (
              <div className={cn("h-full", activeView !== "tools" && "hidden")}>
                <ToolsView agents={agents} />
              </div>
            )}
          </>
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
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
      />
    </>
  );
}

export default App;
