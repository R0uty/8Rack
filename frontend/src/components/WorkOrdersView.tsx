import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { NoMission } from "./NoMission";
import { Button, GlassPanel, SkeletonRows, StatusPill, type Tone } from "./ui";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
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
  onCancel: (id: string) => Promise<WorkOrder>;
}

function WorkOrderCard({ workOrder, onRefreshStatus, onRetry, onCancel }: WorkOrderCardProps) {
  const [task, setTask] = useState<OrchestratorTask | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sendingGuidance, setSendingGuidance] = useState(false);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !workOrder.orchestratorTaskId) return;
    let cancelled = false;
    // The list endpoint returns whatever's currently cached, which can go stale once the
    // underlying task settles into a state nothing has re-synced yet (e.g. it later hit
    // max_time_reached long after this work order last showed "waiting_approval") - re-check
    // before deciding what to show, not just what the card was rendered with.
    const taskId = workOrder.orchestratorTaskId;
    setTaskError(null);
    (async () => {
      try {
        if (NON_TERMINAL.includes(workOrder.status)) await onRefreshStatus(workOrder.id);
      } catch {
        // Only a freshness check - the task itself may still load below.
      }
      try {
        const t = await fetchTask(taskId);
        if (!cancelled) setTask(t);
      } catch (err) {
        if (!cancelled) setTaskError(err instanceof Error ? err.message : "Failed to load the task");
      }
    })();
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
    setActionError(null);
    try {
      await onRetry({
        agentId: workOrder.agentId,
        objective: workOrder.objective,
        target: workOrder.target,
        priority: workOrder.priority,
        relatedAssets: workOrder.relatedAssets,
        relatedFindings: workOrder.relatedFindings,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to retry the work order");
    } finally {
      setRetrying(false);
    }
  };

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      await onCancel(workOrder.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel the work order");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <GlassPanel padding="md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={STATUS_TONE[workOrder.status]}>{workOrder.status.replace(/_/g, " ")}</StatusPill>
            <span className="text-[11px] text-muted">{workOrder.agentId}</span>
          </div>
          <p className={`mt-1.5 text-sm text-text ${open ? "" : "line-clamp-2"}`}>{workOrder.objective}</p>
          {workOrder.target && <p className="mt-0.5 font-mono text-xs text-muted">target: {workOrder.target}</p>}
          <p className="mt-1.5 text-[11px] text-muted">created {relativeTime(workOrder.createdAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(workOrder.status === "failed" || workOrder.status === "cancelled") && (
            <Button variant="secondary" size="sm" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
          {NON_TERMINAL.includes(workOrder.status) && (
            <Button variant="secondary" size="sm" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          {workOrder.orchestratorTaskId && (
            <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Inspect"}
            </Button>
          )}
        </div>
      </div>

      {actionError && <p className="mt-2 text-xs text-critical">{actionError}</p>}

      {open && (
        <div className="mt-3 border-t border-border pt-2.5">
          {!task && !taskError && <SkeletonRows count={2} />}
          {taskError && <p className="text-xs text-critical">{taskError}</p>}

          {task?.status === "waiting_confirmation" && (
            <p className="mb-2 text-xs text-warning">
              This work order is waiting on a tool confirmation - approve or reject it from the Factory Dashboard's
              Approval Queue, and the factory picks it back up from there.
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
 * Every Security Work Order for the mission, grouped by status. A paused order branches on its task's
 * real status - a pending tool confirmation points at the Approval Queue, while a failed tool request
 * (no execution ever created) gets an inline guidance action here. A failed/cancelled order can be
 * retried, recreating it with the same agent/objective/target.
 */
export function WorkOrdersView({ mission, active = true }: { mission: Mission | null; active?: boolean }) {
  const { workOrders, loading, error, refresh, refreshOne, create, start, cancel } = useWorkOrders(mission?.id ?? null);
  useRefreshOnActivate(active, refresh);

  const handleRetry = async (input: WorkOrderCreateInput) => {
    const created = await create(input);
    await start(created.id);
  };

  const grouped = (["running", "waiting_approval", "queued", "pending", "completed", "failed", "cancelled"] as const)
    .map((status) => ({ status, items: workOrders.filter((w) => w.status === status) }))
    .filter((g) => g.items.length > 0);

  if (!mission) return <NoMission />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-xs text-critical">{error}</p>}
      {loading && workOrders.length === 0 && <SkeletonRows count={4} />}
      {!loading && workOrders.length === 0 && (
        <p className="text-xs text-muted">No work orders yet - advance the factory to have the Director create some.</p>
      )}
      <div className="flex flex-col gap-4">
        {grouped.map((group) => (
          <div key={group.status}>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              {group.status.replace(/_/g, " ")} ({group.items.length})
            </p>
            <div className="flex flex-col gap-2">
              {group.items.map((w) => (
                <WorkOrderCard key={w.id} workOrder={w} onRefreshStatus={refreshOne} onRetry={handleRetry} onCancel={cancel} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
