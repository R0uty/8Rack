import { useEffect, useRef, useState } from "react";
import { Activity as ActivityIcon, Play } from "lucide-react";
import { MissionPanel } from "./MissionPanel";
import { FactoryPipeline } from "./FactoryPipeline";
import { ApprovalQueue } from "./ApprovalQueue";
import { ActivityFeed } from "./ActivityFeed";
import { Button, GlassPanel, SectionHeading, StreamingCursor } from "./ui";
import { useMissions } from "../hooks/useMissions";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useTools } from "../hooks/useTools";
import { useActivity } from "../hooks/useActivity";
import { advanceFactory } from "../services/factoryApi";
import type { AgentWithStatus } from "../types/agent";
import type { Mission } from "../types/mission";

interface FactoryDashboardProps {
  agents: AgentWithStatus[];
}

const STAGE_ORDER: Mission["status"][] = [
  "draft",
  "ready",
  "recon",
  "investigating",
  "validating",
  "reporting",
  "review",
  "completed",
];

function StatTile({ label, value, tone }: { label: string; value: number; tone?: "critical" | "warning" }) {
  return (
    <GlassPanel padding="md" className="flex flex-col gap-0.5">
      <span className="text-xl font-semibold text-text" data-tone={tone}>
        {value}
      </span>
      <span className="text-[11px] text-muted">{label}</span>
    </GlassPanel>
  );
}

/**
 * The Factory Dashboard - default landing view. Mission-scoped stat tiles, the visual pipeline
 * (FactoryPipeline), a "Start Factory" control that advances the FactoryDirector one step
 * (streamed, auto-chains until something needs approval), the Approval Queue, and a recent-activity
 * strip. Every stat is derived from hooks other views already use (useAssets/useWorkOrders/
 * useFindings/useTools/useActivity) - no new aggregation endpoint.
 */
export function FactoryDashboard({ agents }: FactoryDashboardProps) {
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
  const { assets, refresh: refreshAssets } = useAssets(selectedMissionId);
  const { workOrders, refresh: refreshWorkOrders } = useWorkOrders(selectedMissionId);
  const { findings, refresh: refreshFindings } = useFindings(selectedMissionId);
  const { executions, refresh: refreshTools } = useTools(selectedMissionId);
  const { events, loading: activityLoading, error: activityError, refresh: refreshActivity } = useActivity(selectedMissionId);

  const [advancing, setAdvancing] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (selectedMissionId && !missionsLoading && !missions.some((m) => m.id === selectedMissionId)) {
      setSelectedMissionId(null);
    }
  }, [missions, missionsLoading, selectedMissionId]);

  const selectedMission = missions.find((m) => m.id === selectedMissionId) ?? null;

  const handleSelectMission = (mission: Mission) => {
    setSelectedMissionId((current) => (current === mission.id ? null : mission.id));
    setBlockedReason(null);
    setAdvanceError(null);
  };

  const refreshAll = () => {
    refreshMissions();
    refreshAssets();
    refreshWorkOrders();
    refreshFindings();
    refreshTools();
    refreshActivity();
  };

  const handleAdvance = async () => {
    if (!selectedMissionId || advancing) return;
    setAdvancing(true);
    setAdvanceError(null);
    setBlockedReason(null);
    setStreamingText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await advanceFactory(
        selectedMissionId,
        (chunk) => setStreamingText((prev) => prev + chunk),
        controller.signal,
      );
      setBlockedReason(result.blockedReason ?? null);
      refreshAll();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setAdvanceError(err instanceof Error ? err.message : "Factory advance failed");
      }
    } finally {
      setAdvancing(false);
    }
  };

  const runningWorkOrders = workOrders.filter((w) => w.status === "running").length;
  const activeWorkOrders = workOrders.filter((w) => w.status === "running" || w.status === "waiting_approval" || w.status === "queued").length;
  const potentialFindings = findings.filter((f) => f.status === "potential" || f.status === "investigating").length;
  const confirmedFindings = findings.filter((f) => f.status === "confirmed").length;
  const criticalHighFindings = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const pendingApprovals = executions.filter((e) => e.status === "pending_confirmation").length;
  const stageIndex = selectedMission?.status ? STAGE_ORDER.indexOf(selectedMission.status) : -1;

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

      {!selectedMission && <p className="text-xs text-muted">Select or create a mission above to open its factory dashboard.</p>}

      {selectedMission && (
        <>
          <GlassPanel padding="md" className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text">{selectedMission.name}</span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                  {selectedMission.status ?? "draft"}
                </span>
              </div>
              {stageIndex >= 0 && (
                <div className="mt-2 flex gap-0.5">
                  {STAGE_ORDER.map((s, i) => (
                    <span
                      key={s}
                      className={`h-1.5 flex-1 rounded-full ${i <= stageIndex ? "bg-primary" : "bg-surface-2"}`}
                    />
                  ))}
                </div>
              )}
            </div>
            <Button variant="primary" icon={Play} onClick={handleAdvance} disabled={advancing}>
              {advancing ? "Running…" : "Start / Advance Factory"}
            </Button>
          </GlassPanel>

          {!selectedMission.scope?.length && (
            <p className="rounded-lg border border-warning/30 bg-warning-dim px-2.5 py-2 text-xs text-warning">
              This mission has no scope configured — the Director won't start Recon until at least
              one in-scope target is set. Edit the mission (pencil icon above) to add one.
            </p>
          )}
          {blockedReason && (
            <p className="rounded-lg border border-warning/30 bg-warning-dim px-2.5 py-2 text-xs text-warning">
              {blockedReason}
            </p>
          )}
          {advanceError && <p className="text-xs text-critical">{advanceError}</p>}
          {advancing && streamingText && (
            <GlassPanel padding="md" className="max-h-40 overflow-y-auto font-mono text-xs text-muted">
              {streamingText}
              <StreamingCursor />
            </GlassPanel>
          )}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
            <StatTile label="Assets" value={assets.length} />
            <StatTile label="Work orders" value={activeWorkOrders} />
            <StatTile label="Running agents" value={runningWorkOrders} />
            <StatTile label="Potential findings" value={potentialFindings} />
            <StatTile label="Confirmed findings" value={confirmedFindings} />
            <StatTile label="Critical / High" value={criticalHighFindings} tone="critical" />
            <StatTile label="Pending approvals" value={pendingApprovals} tone="warning" />
          </div>

          <FactoryPipeline mission={selectedMission} workOrders={workOrders} findings={findings} />

          <ApprovalQueue missionName={selectedMission.name} executions={executions} agents={agents} onSettled={refreshAll} />

          <section>
            <SectionHeading actions={<ActivityIcon size={14} className="text-muted" />}>Recent Activity</SectionHeading>
            <ActivityFeed events={events.slice(0, 8)} loading={activityLoading} error={activityError} />
          </section>
        </>
      )}
    </div>
  );
}
