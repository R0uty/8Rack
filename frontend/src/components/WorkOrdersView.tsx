import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { MissionPanel } from "./MissionPanel";
import { Markdown } from "./Markdown";
import { Button, GlassPanel, IconButton, SectionHeading, SkeletonRows, StatusPill, type Tone } from "./ui";
import { useMissions } from "../hooks/useMissions";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { fetchTask, provideGuidance } from "../services/orchestratorApi";
import { relativeTime } from "../lib/relativeTime";
import type { Mission } from "../types/mission";
import type { WorkOrder, WorkOrderCreateInput, WorkOrderStatus } from "../types/workOrder";
import type { OrchestratorTask } from "../types/orchestrator";

const STATUS_TONE: Record<WorkOrderStatus, Tone> = {
  pending: "neutral",
  queued: "neutral",
  running: "info",
  waiting_approval: "warning",
  completed: "primary",
  failed: "critical",
  cancelled: "neutral",
};

const NON_TERMINAL: WorkOrder["status"][] = ["pending", "queued", "running", "waiting_approval"];

interface WorkOrderCardProps {
  workOrder: WorkOrder;
  onRefreshStatus: (id: string) => Promise<WorkOrder>;
  onRetry: (input: WorkOrderCreateInput) => Promise<void>;
}

function WorkOrderCard({ workOrder, onRefreshStatus, onRetry }: WorkOrderCardProps) {
  const [task, setTask] = useState<OrchestratorTask | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sendingGuidance, setSendingGuidance] = useState(false);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !workOrder.orchestratorTaskId) return;
    let cancelled = false;
    // The list endpoint returns whatever's currently cached, which can go stale once the
    // underlying task settles into a state nothing has re-synced yet (e.g. it later hit
    // max_time_reached long after this work order last showed "waiting_approval") - re-check
    // before deciding what to show, not just what the card was rendered with.
    (NON_TERMINAL.includes(workOrder.status) ? onRefreshStatus(workOrder.id) : Promise.resolve()).finally(() => {
      if (cancelled || !workOrder.orchestratorTaskId) return;
      fetchTask(workOrder.orchestratorTaskId).then((t) => {
        if (!cancelled) setTask(t);
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrder.orchestratorTaskId]);

  const handleSendGuidance = async () => {
    if (!task || sendingGuidance) return;
    setSendingGuidance(true);
    setGuidanceError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const updated = await provideGuidance(task.id, note.trim() || undefined, () => {}, controller.signal);
      setTask(updated);
      setNote("");
      await onRefreshStatus(workOrder.id);
    } catch (err) {
      setGuidanceError(err instanceof Error ? err.message : "Failed to send guidance");
    } finally {
      setSendingGuidance(false);
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry({
        agentId: workOrder.agentId,
        objective: workOrder.objective,
        target: workOrder.target,
        priority: workOrder.priority,
        relatedAssets: workOrder.relatedAssets,
        relatedFindings: workOrder.relatedFindings,
      });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <GlassPanel padding="md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={STATUS_TONE[workOrder.status]}>{workOrder.status.replace(/_/g, " ")}</StatusPill>
            <span className="text-[11px] text-muted">priority {workOrder.priority}</span>
            <span className="text-[11px] text-muted">{workOrder.agentId}</span>
          </div>
          <p className="mt-1.5 text-sm text-text">{workOrder.objective}</p>
          {workOrder.target && <p className="mt-0.5 font-mono text-xs text-muted">target: {workOrder.target}</p>}
          <div className="mt-1.5 flex flex-wrap gap-2 text-[11px] text-muted">
            {workOrder.dependencies.length > 0 && <span>{workOrder.dependencies.length} dependencies</span>}
            {workOrder.relatedAssets.length > 0 && <span>{workOrder.relatedAssets.length} related assets</span>}
            {workOrder.relatedFindings.length > 0 && <span>{workOrder.relatedFindings.length} related findings</span>}
            <span>created {relativeTime(workOrder.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(workOrder.status === "failed" || workOrder.status === "cancelled") && (
            <Button variant="secondary" size="sm" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
          {workOrder.orchestratorTaskId && (
            <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Inspect"}
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-3 border-t border-border pt-2.5">
          {!task && <SkeletonRows count={2} />}

          {task?.status === "waiting_confirmation" && (
            <p className="mb-2 text-xs text-warning">
              This work order is waiting on a tool confirmation - approve or reject it from the Factory Dashboard's
              Approval Queue, then advance the factory again.
            </p>
          )}

          {task?.status === "waiting_guidance" && (
            <div className="mb-2 flex flex-col gap-2">
              <p className="text-xs text-warning">
                The agent's last tool request failed outright (an invalid or unavailable tool - see the transcript
                below), so there's no execution to approve. Give it a note to steer the retry, or leave it blank to
                just let it try again.
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note, e.g. subfinder isn't installed - use dig instead"
                rows={2}
                disabled={sendingGuidance}
                className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
              />
              {guidanceError && <p className="text-xs text-critical">{guidanceError}</p>}
              <Button variant="primary" size="sm" onClick={handleSendGuidance} disabled={sendingGuidance}>
                {sendingGuidance ? "Sending…" : "Continue"}
              </Button>
            </div>
          )}

          {task?.finalResponse && <Markdown content={task.finalResponse} />}
          {task && !task.finalResponse && task.status !== "waiting_guidance" && task.status !== "waiting_confirmation" && (
            <p className="text-xs text-muted">No final response yet ({task.status}).</p>
          )}
        </div>
      )}
    </GlassPanel>
  );
}

/**
 * The Work Orders nav view: every Security Work Order for the selected mission, grouped by status.
 * A running/completed order's underlying OrchestratorTask is fetched read-only for a quick preview
 * (its final response) on demand; its status is re-synced from that task on open, since the list
 * endpoint alone can go stale. A paused order branches on the task's real status - a pending tool
 * confirmation points at the Approval Queue, while a failed tool *request* (no execution ever
 * created) gets a real inline guidance action, since there's no other UI surface for that state any
 * more. A failed/cancelled order can be retried directly, recreating it with the same agent/
 * objective/target.
 */
export function WorkOrdersView() {
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
  const { workOrders, loading, error, refresh, refreshOne, create, start } = useWorkOrders(selectedMissionId);

  useEffect(() => {
    if (selectedMissionId && !missionsLoading && !missions.some((m) => m.id === selectedMissionId)) {
      setSelectedMissionId(null);
    }
  }, [missions, missionsLoading, selectedMissionId]);

  const handleSelectMission = (mission: Mission) => {
    setSelectedMissionId((current) => (current === mission.id ? null : mission.id));
  };

  const handleRetry = async (input: WorkOrderCreateInput) => {
    const created = await create(input);
    await start(created.id);
  };

  const grouped = (["running", "waiting_approval", "queued", "pending", "completed", "failed", "cancelled"] as const)
    .map((status) => ({ status, items: workOrders.filter((w) => w.status === status) }))
    .filter((g) => g.items.length > 0);

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

      {!selectedMissionId && <p className="text-xs text-muted">Select or create a mission above to view its work orders.</p>}

      {selectedMissionId && (
        <>
          <SectionHeading actions={<IconButton icon={RefreshCw} label="Refresh" size="sm" onClick={refresh} />}>
            Work Orders
          </SectionHeading>
          {error && <p className="text-xs text-critical">{error}</p>}
          {loading && workOrders.length === 0 && <SkeletonRows count={4} />}
          {!loading && workOrders.length === 0 && (
            <p className="text-xs text-muted">
              No work orders yet - use "Start / Advance Factory" on the Factory Dashboard to have the Director create
              some.
            </p>
          )}
          <div className="flex flex-col gap-4">
            {grouped.map((group) => (
              <div key={group.status}>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                  {group.status.replace(/_/g, " ")} ({group.items.length})
                </p>
                <div className="flex flex-col gap-2">
                  {group.items.map((w) => (
                    <WorkOrderCard key={w.id} workOrder={w} onRefreshStatus={refreshOne} onRetry={handleRetry} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
