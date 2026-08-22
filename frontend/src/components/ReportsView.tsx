import { useEffect, useState } from "react";
import { MissionPanel } from "./MissionPanel";
import { ReportsPanel } from "./ReportsPanel";
import { SectionHeading } from "./ui";
import { useMissions } from "../hooks/useMissions";
import { useReports } from "../hooks/useReports";
import type { Mission } from "../types/mission";

/**
 * The Reports nav view: browse/manage a mission's generated reports, including the new
 * Draft/AI Generated/Human Review/Ready/Submitted status control (spec's Report Factory state
 * machine). Generation itself still happens from FindingsView's "Generate Report" bar (select
 * findings there first) - this view is for what happens to a report after it exists.
 */
export function ReportsView() {
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
  const { reports, loading, error, remove, setStatus } = useReports(selectedMissionId);

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

      {!selectedMissionId && <p className="text-xs text-muted">Select or create a mission above to view its reports.</p>}

      {selectedMissionId && (
        <>
          <SectionHeading>Reports</SectionHeading>
          <ReportsPanel reports={reports} loading={loading} error={error} onDelete={remove} onChangeStatus={setStatus} />
        </>
      )}
    </div>
  );
}
