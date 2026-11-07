import { useState, type ReactNode } from "react";
import { AppShell, Sidebar, TopBar, type AppView } from "./components/layout";
import { cn } from "./lib/cn";
import { AgentEditor } from "./components/AgentEditor";
import { MissionEditor } from "./components/MissionEditor";
import { MissionSwitcher } from "./components/MissionSwitcher";
import { FindingsView } from "./components/FindingsView";
import { FactoryDashboard } from "./components/FactoryDashboard";
import { AssetsView } from "./components/AssetsView";
import { WorkOrdersView } from "./components/WorkOrdersView";
import { ReportsView } from "./components/ReportsView";
import { AgentsView } from "./components/AgentsView";
import { ToolsView } from "./components/ToolsView";
import { useModels } from "./hooks/useModels";
import { useAgents } from "./hooks/useAgents";
import { useMissions } from "./hooks/useMissions";
import { useSelectedMission } from "./hooks/useSelectedMission";
import { useTools } from "./hooks/useTools";
import { useTheme } from "./hooks/useTheme";
import type { AgentWithStatus } from "./types/agent";
import type { Mission } from "./types/mission";

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
  const {
    missions,
    loading: missionsLoading,
    error: missionsError,
    refresh: refreshMissions,
    create: createMission,
    update: updateMission,
    remove: removeMission,
  } = useMissions();
  const { mission, select: selectMission } = useSelectedMission(missions);
  // Tool list isn't mission-scoped (only execution history is) - null just skips fetching
  // executions this hook would otherwise pull in, since App.tsx only needs it for AgentEditor's
  // tool-access preview.
  const { tools: execTools } = useTools(null);
  const { theme, toggle: toggleTheme } = useTheme();
  const [activeView, setActiveView] = useState<AppView>("factory");
  // Every view a user has ever switched to stays mounted forever after - a view's own React state
  // (e.g. its filters, an in-flight NDJSON stream) would otherwise reset on every nav switch. Views
  // are lazily added on first visit rather than all mounted upfront, so switching to a view you've
  // never opened doesn't fire its data fetches for nothing.
  const [visitedViews, setVisitedViews] = useState<Set<AppView>>(() => new Set(["factory"]));
  const changeView = (view: AppView) => {
    setActiveView(view);
    setVisitedViews((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  };
  // undefined = editor closed, null = create mode, an agent/mission = edit mode.
  const [editingAgent, setEditingAgent] = useState<AgentWithStatus | null | undefined>(undefined);
  const [editingMission, setEditingMission] = useState<Mission | null | undefined>(undefined);
  const [advancing, setAdvancing] = useState(false);

  const ollamaStatus = modelsError ? "unavailable" : modelsLoading ? "unknown" : "connected";

  const handleSaveMission = async (id: string | null, patch: Partial<Mission>) => {
    if (id) {
      await updateMission(id, patch);
      return;
    }
    const { name = "", notes = "", ...fields } = patch;
    selectMission((await createMission(name, notes, fields)).id);
  };

  const view = (name: AppView, content: ReactNode) =>
    visitedViews.has(name) && <div className={cn("h-full", activeView !== name && "hidden")}>{content}</div>;

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            activeView={activeView}
            onChangeView={changeView}
            ollamaStatus={ollamaStatus}
            missionSwitcher={
              <MissionSwitcher
                missions={missions}
                selected={mission}
                loading={missionsLoading}
                error={missionsError}
                disabled={advancing}
                onSelect={selectMission}
                onNew={() => setEditingMission(null)}
                onEdit={setEditingMission}
              />
            }
          />
        }
        topBar={<TopBar activeView={activeView} theme={theme} onToggleTheme={toggleTheme} />}
        center={
          <>
            {view(
              "factory",
              <FactoryDashboard
                agents={agents}
                mission={mission}
                active={activeView === "factory"}
                onMissionsChanged={refreshMissions}
                onAdvancingChange={setAdvancing}
                onOpenView={changeView}
              />,
            )}
            {view("workorders", <WorkOrdersView mission={mission} active={activeView === "workorders"} />)}
            {view("assets", <AssetsView mission={mission} active={activeView === "assets"} />)}
            {view("findings", <FindingsView mission={mission} active={activeView === "findings"} />)}
            {view("reports", <ReportsView mission={mission} active={activeView === "reports"} />)}
            {view(
              "agents",
              <AgentsView
                agents={agents}
                loading={agentsLoading}
                error={agentsError}
                warnings={agentWarnings}
                execTools={execTools}
                onRefresh={refreshAgents}
                onCreateAgent={() => setEditingAgent(null)}
                onEditAgent={setEditingAgent}
              />,
            )}
            {view("tools", <ToolsView agents={agents} mission={mission} active={activeView === "tools"} />)}
          </>
        }
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

      <MissionEditor
        open={editingMission !== undefined}
        mission={editingMission ?? null}
        onSave={handleSaveMission}
        onDelete={removeMission}
        onClose={() => setEditingMission(undefined)}
      />
    </>
  );
}

export default App;
