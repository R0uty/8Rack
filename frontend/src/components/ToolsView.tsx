import { useEffect, useState } from "react";
import { ToolRegistry } from "./ToolRegistry";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";
import { ScannerPanel } from "./ScannerPanel";
import { MissionPanel } from "./MissionPanel";
import { useMissions } from "../hooks/useMissions";
import { useTools } from "../hooks/useTools";
import type { AgentWithStatus } from "../types/agent";
import type { Mission } from "../types/mission";

interface ToolsViewProps {
  agents: AgentWithStatus[];
}

/**
 * The Tools nav view: the Tool Registry (browse/enable exec tools, server-side authoritative),
 * mission-scoped Execution History, and Security Scanners (deterministic chained tool runs) - all
 * tool-related, so they share this one page rather than each owning a separate nav item.
 */
export function ToolsView({ agents }: ToolsViewProps) {
  const {
    missions,
    loading: missionsLoading,
    error: missionsError,
    refresh: refreshMissions,
    create: createMission,
    update: updateMission,
    remove: removeMission,
  } = useMissions();
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const { tools, executions, loading, error, refresh, toggleTool } = useTools(selectedMissionId);

  useEffect(() => {
    if (selectedMissionId && !missionsLoading && !missions.some((m) => m.id === selectedMissionId)) {
      setSelectedMissionId(null);
    }
  }, [missions, missionsLoading, selectedMissionId]);

  const handleSelectMission = (mission: Mission) => {
    setSelectedMissionId((current) => (current === mission.id ? null : mission.id));
  };

  return (
    <div className="flex flex-col gap-4">
      <MissionPanel
        missions={missions}
        loading={missionsLoading}
        error={missionsError}
        selectedMissionId={selectedMissionId}
        onSelect={handleSelectMission}
        onCreate={createMission}
        onUpdate={updateMission}
        onDelete={removeMission}
        onRefresh={refreshMissions}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ToolRegistry
          tools={tools}
          executions={executions}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onToggleEnabled={toggleTool}
        />
        <ExecutionHistoryPanel executions={executions} loading={loading} error={error} onRefresh={refresh} agents={agents} />
      </div>

      {selectedMissionId && <ScannerPanel missionId={selectedMissionId} />}
    </div>
  );
}
