import { useEffect, useState } from "react";
import { Bell, BellOff, FileText, Pencil, Play, Square, Wrench } from "lucide-react";
import { FactoryPipeline } from "./FactoryPipeline";
import { NeedsYouQueue } from "./NeedsYouQueue";
import { ActivityFeed } from "./ActivityFeed";
import { NoMission } from "./NoMission";
import { SetupChecklist } from "./SetupChecklist";
import { Button, FOCUS_RING, GlassPanel, IconButton, Notice, SectionHeading, StreamingCursor } from "./ui";
import type { AppView } from "./layout";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useAttention, useFactoryPreview } from "../hooks/useAttention";
import { useAttentionAlerts } from "../hooks/useAttentionAlerts";
import { useActivity } from "../hooks/useActivity";
import { useReports } from "../hooks/useReports";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { useMissionLive } from "../hooks/useMissionEvents";
import { advanceFactory, stopFactory } from "../services/factoryApi";
import { useAppNav } from "../lib/appNav";
import { agentName } from "../lib/agentName";
import { describePreview, needsYouCount } from "../lib/attention";
import { splitAgentOutput } from "../lib/agentOutput";
import type { AgentWithStatus } from "../types/agent";
import type { Mission } from "../types/mission";

interface FactoryDashboardProps {
  agents: AgentWithStatus[];
  mission: Mission | null;
  active?: boolean;
  onMissionsChanged?: () => void;
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

/** The current order's output, with tool calls as readable lines instead of JSON. */
function LiveOutput({ output }: { output: string }) {
  return (
    <div className="max-h-48 overflow-y-auto font-mono text-xs text-muted">
      {splitAgentOutput(output).map((part, i) =>
        part.kind === "text" ? (
          <p key={i} className="whitespace-pre-wrap">
            {part.text}
          </p>
        ) : (
          <p key={i} className="my-1 flex items-center gap-1.5 text-info">
            <Wrench size={11} aria-hidden />
            <span>
              {part.tool} {part.args.join(" ")}
            </span>
          </p>
        ),
      )}
      <StreamingCursor />
    </div>
  );
}

/**
 * The default landing view, in the order a human needs it: run the mission, decide what's waiting on
 * you, see where things stand, then what happened. The run itself lives on the server; this view
 * follows it through the mission's event stream.
 */
export function FactoryDashboard({ agents, mission, active = true, onMissionsChanged, onOpenView }: FactoryDashboardProps) {
  const missionId = mission?.id ?? null;
  const { assets, refresh: refreshAssets } = useAssets(missionId);
  const { workOrders, refresh: refreshWorkOrders } = useWorkOrders(missionId);
  const { findings, refresh: refreshFindings } = useFindings(missionId);
  const { attention, error: attentionError, refresh: refreshAttention } = useAttention(missionId);
  const { preview, refresh: refreshPreview } = useFactoryPreview(missionId);
  const { events, loading: activityLoading, error: activityError, refresh: refreshActivity } = useActivity(missionId);
  const { reports, generating, error: reportsError, refresh: refreshReports, generate: generateReport } = useReports(missionId);
  const { editMission } = useAppNav();

  const { run, output, outputWorkOrderId } = useMissionLive(missionId);
  const running = run?.status === "running";
  const blockedReason = run && (run.status === "blocked" || run.status === "waiting_guidance") ? (run.reason ?? null) : null;
  const outputOrder = workOrders.find((w) => w.id === outputWorkOrderId);

  const count = needsYouCount(attention);
  const alerts = useAttentionAlerts(count, mission?.name);

  const [requesting, setRequesting] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);

  useEffect(() => {
    setAdvanceError(null);
    setShowAllActivity(false);
  }, [missionId]);

  const refreshAll = () => {
    onMissionsChanged?.();
    refreshAssets();
    refreshWorkOrders();
    refreshFindings();
    refreshAttention();
    refreshPreview();
    refreshActivity();
    refreshReports();
  };

  useRefreshOnActivate(active, refreshAll);

  const runAction = async (action: (missionId: string) => Promise<unknown>, failure: string) => {
    if (!missionId || requesting) return;
    setRequesting(true);
    setAdvanceError(null);
    try {
      await action(missionId);
    } catch (err) {
      setAdvanceError(err instanceof Error ? err.message : failure);
    } finally {
      setRequesting(false);
    }
  };
  const handleAdvance = () => runAction(advanceFactory, "Factory advance failed");
  const handleStop = () => runAction(stopFactory, "Couldn't stop the run");

  if (!mission)
    return (
      <div className="flex flex-col gap-4">
        <SetupChecklist />
        <NoMission />
      </div>
    );

  const activeWorkOrders = workOrders.filter((w) => w.status === "running" || w.status === "waiting_approval" || w.status === "queued").length;
  const potentialFindings = findings.filter((f) => f.status === "potential" || f.status === "investigating").length;
  const reportableIds = findings.filter((f) => f.status === "confirmed").map((f) => f.id);
  const nextLine = describePreview(preview, agents);

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
      <SetupChecklist />
      <GlassPanel padding="md" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{mission.name}</p>
            {mission.scope?.length ? (
              <p className="truncate font-mono text-xs text-muted">{mission.scope.join(", ")}</p>
            ) : editMission ? (
              <button type="button" onClick={() => editMission(mission)} className={`flex items-center gap-1 text-xs text-warning underline-offset-2 hover:underline ${FOCUS_RING}`}>
                <Pencil size={11} aria-hidden />
                No scope set - add a target so recon can start
              </button>
            ) : (
              <p className="text-xs text-warning">No scope set - add a target before recon can start.</p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {alerts.supported && (
              <IconButton
                icon={alerts.enabled ? Bell : BellOff}
                label={alerts.enabled ? "Stop notifying me when something needs me" : "Notify me when something needs me"}
                size="sm"
                onClick={() => void alerts.toggle()}
              />
            )}
            {running ? (
              <Button variant="secondary" icon={Square} onClick={handleStop} disabled={requesting}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" icon={Play} onClick={handleAdvance} disabled={requesting}>
                Advance factory
              </Button>
            )}
          </div>
        </div>
        <FactoryPipeline mission={mission} />
        {!running && nextLine && (
          <p className="text-xs text-muted" role="status">
            {nextLine}
          </p>
        )}
        {running && (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] text-muted" role="status">
              Running{outputOrder ? `: ${agentName(agents, outputOrder.agentId)} - ${outputOrder.objective}` : "…"}
            </p>
            {output && <LiveOutput output={output} />}
          </div>
        )}
      </GlassPanel>

      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {advanceError && <Notice>{advanceError}</Notice>}
      {reportsError && <Notice>{reportsError}</Notice>}
      {attentionError && <Notice>Couldn't load what needs you: {attentionError}</Notice>}
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

      <NeedsYouQueue missionId={mission.id} missionName={mission.name} attention={attention} agents={agents} onChanged={refreshAttention} />

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
