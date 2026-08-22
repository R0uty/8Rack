import { useEffect, useState } from "react";
import { FactoryIcon } from "lucide-react";
import { MissionPanel } from "./MissionPanel";
import { ActivityFeed } from "./ActivityFeed";
import { Button, SectionHeading } from "./ui";
import { useMissions } from "../hooks/useMissions";
import { useActivity } from "../hooks/useActivity";
import type { Mission } from "../types/mission";

interface MissionsViewProps {
  /** Switches the app over to the Factory Dashboard - per this app's existing per-page mission
   * selection convention (see CLAUDE.md's "Missions" section), the dashboard keeps its own
   * MissionPanel selection rather than App.tsx holding one shared "current mission", so this only
   * changes the view; the user re-selects the same mission there. */
  onOpenFactory: () => void;
}

/**
 * The Missions nav view: the full mission-management hub (create/edit/delete, same MissionPanel/
 * MissionEditor every other mission-scoped view already uses) plus that mission's full Activity
 * Timeline - the natural home for it now that it's no longer a FindingsView tab.
 */
export function MissionsView({ onOpenFactory }: MissionsViewProps) {
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
  const { events, loading: activityLoading, error: activityError } = useActivity(selectedMissionId);

  useEffect(() => {
    if (selectedMissionId && !missionsLoading && !missions.some((m) => m.id === selectedMissionId)) {
      setSelectedMissionId(null);
    }
  }, [missions, missionsLoading, selectedMissionId]);

  const selectedMission = missions.find((m) => m.id === selectedMissionId) ?? null;

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

      {selectedMission && (
        <>
          <div className="flex items-center justify-between">
            <SectionHeading>Activity — {selectedMission.name}</SectionHeading>
            <Button variant="secondary" size="sm" icon={FactoryIcon} onClick={onOpenFactory}>
              Open Factory Dashboard
            </Button>
          </div>
          <ActivityFeed events={events} loading={activityLoading} error={activityError} />
        </>
      )}
    </div>
  );
}
