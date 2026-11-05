import { useEffect, useRef, useState } from "react";
import { FileText, Play } from "lucide-react";
import { FactoryPipeline } from "./FactoryPipeline";
import { ApprovalQueue } from "./ApprovalQueue";
import { ActivityFeed } from "./ActivityFeed";
import { NoMission } from "./NoMission";
import { Button, FOCUS_RING, GlassPanel, SectionHeading, StreamingCursor } from "./ui";
import type { AppView } from "./layout";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useTools } from "../hooks/useTools";
import { useActivity } from "../hooks/useActivity";
import { useReports } from "../hooks/useReports";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { advanceFactory } from "../services/factoryApi";
import type { AgentWithStatus } from "../types/agent";
import type { Mission } from "../types/mission";

interface FactoryDashboardProps {
  agents: AgentWithStatus[];
  mission: Mission | null;
  active?: boolean;
  onMissionsChanged?: () => void;
  onAdvancingChange?: (advancing: boolean) => void;
  onOpenView?: (view: AppView) => void;
}

const RECENT_ACTIVITY = 8;

function StatTile({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-0.5 rounded-panel border border-border bg-card/60 p-3 text-left transition-colors hover:border-border-strong ${FOCUS_RING}`}
    >
      <span className="text-xl font-semibold text-text">{value}</span>
      <span className="text-[11px] text-muted">{label}</span>
    </button>
  );
}

/**
 * The default landing view, in the order a human needs it: run the mission, decide what's waiting on
 * you, see where things stand, then what happened. Every number comes from hooks other views already
 * use - no aggregation endpoint.
 */
export function FactoryDashboard({ agents, mission, active = true, onMissionsChanged, onAdvancingChange, onOpenView }: FactoryDashboardProps) {
  const missionId = mission?.id ?? null;
  const { assets, refresh: refreshAssets } = useAssets(missionId);
  const { workOrders, refresh: refreshWorkOrders } = useWorkOrders(missionId);
  const { findings, refresh: refreshFindings } = useFindings(missionId);
  const { executions, refresh: refreshTools } = useTools(missionId);
  const { events, loading: activityLoading, error: activityError, refresh: refreshActivity } = useActivity(missionId);
  const { reports, generating, error: reportsError, refresh: refreshReports, generate: generateReport } = useReports(missionId);

  const [advancing, setAdvancing] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    onAdvancingChange?.(advancing);
  }, [advancing, onAdvancingChange]);

  useEffect(() => {
    setBlockedReason(null);
    setAdvanceError(null);
    setShowAllActivity(false);
  }, [missionId]);

  const refreshAll = () => {
    onMissionsChanged?.();
    refreshAssets();
    refreshWorkOrders();
    refreshFindings();
    refreshTools();
    refreshActivity();
    refreshReports();
  };

  useRefreshOnActivate(active, refreshAll);

  const handleAdvance = async () => {
    if (!missionId || advancing) return;
    setAdvancing(true);
    setAdvanceError(null);
    setBlockedReason(null);
    setStreamingText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await advanceFactory(missionId, (chunk) => setStreamingText((prev) => prev + chunk), controller.signal);
      setBlockedReason(result.blockedReason ?? null);
      refreshAll();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setAdvanceError(err instanceof Error ? err.message : "Factory advance failed");
        refreshAll(); // a chain can fail partway, after settling earlier work orders
      }
    } finally {
      setAdvancing(false);
    }
  };

  // A human decision is what the paused work order was waiting on, so that's what picks it back up -
  // anything further the agent wants to run still stops at this same queue.
  const handleApprovalSettled = () => {
    refreshAll();
    void handleAdvance();
  };

  if (!mission) return <NoMission />;

  const activeWorkOrders = workOrders.filter((w) => w.status === "running" || w.status === "waiting_approval" || w.status === "queued").length;
  const failedWorkOrders = workOrders.filter((w) => w.status === "failed").length;
  const potentialFindings = findings.filter((f) => f.status === "potential" || f.status === "investigating").length;
  const reportableIds = findings.filter((f) => f.status === "confirmed").map((f) => f.id);

  // The Director settles a fully-worked mission at `reporting` and then stops (report generation
  // stays an explicit human act) - so a mission sitting at reporting with confirmed findings but no
  // report yet is the moment to nudge.
  const showReportNudge = mission.status === "reporting" && reportableIds.length > 0 && reports.length === 0;

  const handleGenerateReport = async () => {
    if (reportableIds.length === 0 || generating) return;
    await generateReport(`${mission.name} Report`, reportableIds);
    refreshReports();
  };

  return (
    <div className="flex flex-col gap-4">
      <GlassPanel padding="md" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{mission.name}</p>
            {mission.scope?.length ? (
              <p className="truncate font-mono text-xs text-muted">{mission.scope.join(", ")}</p>
            ) : (
              <p className="text-xs text-warning">No scope set - add a target before recon can start.</p>
            )}
          </div>
          <Button variant="primary" icon={Play} onClick={handleAdvance} disabled={advancing}>
            {advancing ? "Running…" : "Advance factory"}
          </Button>
        </div>
        <FactoryPipeline mission={mission} />
        {advancing && streamingText && (
          <div className="max-h-40 overflow-y-auto font-mono text-xs text-muted">
            {streamingText}
            <StreamingCursor />
          </div>
        )}
      </GlassPanel>

      {blockedReason && (
        <p className="rounded-lg border border-warning/30 bg-warning-dim px-2.5 py-2 text-xs text-warning">{blockedReason}</p>
      )}
      {advanceError && <p className="text-xs text-critical">{advanceError}</p>}
      {reportsError && <p className="text-xs text-critical">{reportsError}</p>}
      {failedWorkOrders > 0 && !blockedReason && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-critical/30 px-2.5 py-2 text-xs text-critical">
          {failedWorkOrders} work order{failedWorkOrders === 1 ? "" : "s"} failed.
          <Button variant="secondary" size="sm" onClick={() => onOpenView?.("workorders")}>
            View
          </Button>
        </div>
      )}
      {showReportNudge && (
        <GlassPanel padding="md" className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">
            Ready for a report from {reportableIds.length} confirmed finding{reportableIds.length === 1 ? "" : "s"}.
          </span>
          <Button variant="primary" size="sm" icon={FileText} onClick={handleGenerateReport} disabled={generating}>
            {generating ? "Generating…" : "Generate report now"}
          </Button>
        </GlassPanel>
      )}

      <ApprovalQueue missionName={mission.name} executions={executions} agents={agents} onSettled={handleApprovalSettled} />

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="Active work orders" value={activeWorkOrders} onClick={() => onOpenView?.("workorders")} />
        <StatTile label="Assets" value={assets.length} onClick={() => onOpenView?.("assets")} />
        <StatTile label="Findings to review" value={potentialFindings} onClick={() => onOpenView?.("findings")} />
        <StatTile label="Confirmed findings" value={reportableIds.length} onClick={() => onOpenView?.("findings")} />
      </div>

      <section>
        <SectionHeading
          actions={
            events.length > RECENT_ACTIVITY ? (
              <Button variant="ghost" size="sm" onClick={() => setShowAllActivity((s) => !s)}>
                {showAllActivity ? "Show recent" : `Show all (${events.length})`}
              </Button>
            ) : undefined
          }
        >
          Activity
        </SectionHeading>
        <ActivityFeed
          events={showAllActivity ? events : events.slice(0, RECENT_ACTIVITY)}
          loading={activityLoading}
          error={activityError}
        />
      </section>
    </div>
  );
}
