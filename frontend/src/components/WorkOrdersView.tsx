import { useEffect, useState } from "react";
import { ClipboardList, Play, Plus } from "lucide-react";
import { Markdown } from "./Markdown";
import { NoMission } from "./NoMission";
import { NewWorkOrderSheet } from "./NewWorkOrderSheet";
import { TaskTranscript } from "./TaskTranscript";
import { Button, EmptyState, GlassPanel, Notice, SkeletonRows, StatusPill, type Tone } from "./ui";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { fetchTask } from "../services/orchestratorApi";
import { useAppNav } from "../lib/appNav";
import { agentName } from "../lib/agentName";
import { relativeTime } from "../lib/relativeTime";
import type { AgentWithStatus } from "../types/agent";
import type { Finding } from "../types/finding";
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

/** What went wrong, from the tool result a paused task stopped on - a refused request carries `error`,
 * a run that failed carries its `stderr`. */
function lastToolProblem(task: OrchestratorTask): string | undefined {
  const last = task.messages.findLast((m) => m.role === "tool");
  if (!last) return undefined;
  try {
    const result = JSON.parse(last.content) as { error?: unknown; message?: unknown; stderr?: unknown };
    return [result.error, result.message, result.stderr].find((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return undefined;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface WorkOrderCardProps {
  workOrder: WorkOrder;
  agents: AgentWithStatus[];
  findings: Finding[];
  /** Another order was created to retry this one - it no longer needs attention. */
  retried?: boolean;
  onRefreshStatus: (id: string) => Promise<WorkOrder>;
  onStart: (id: string) => Promise<unknown>;
  onRetry: (input: WorkOrderCreateInput) => Promise<void>;
  onCancel: (id: string) => Promise<WorkOrder>;
  onGuide: (id: string, note?: string) => Promise<WorkOrder>;
}

function WorkOrderCard({ workOrder, agents, findings, retried = false, onRefreshStatus, onStart, onRetry, onCancel, onGuide }: WorkOrderCardProps) {
  const { openView } = useAppNav();
  const [task, setTask] = useState<OrchestratorTask | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sendingGuidance, setSendingGuidance] = useState(false);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "retry" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !workOrder.orchestratorTaskId) return;
    let cancelled = false;
    // The list endpoint returns whatever's currently cached, which can go stale once the
    // underlying task settles into a state nothing has re-synced yet - re-check before deciding what
    // to show, not just what the card was rendered with.
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
    // Re-read when the order's status or tool-call count changes (the run moves on in the
    // background), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrder.orchestratorTaskId, workOrder.status, workOrder.toolCallCount]);

  const handleSendGuidance = async () => {
    if (!task || sendingGuidance) return;
    setSendingGuidance(true);
    setGuidanceError(null);
    try {
      // Returns at once: the agent continues on the server as the mission's run.
      await onGuide(workOrder.id, note.trim() || undefined);
      setNote("");
      setTask(await fetchTask(task.id));
    } catch (err) {
      setGuidanceError(err instanceof Error ? err.message : "Failed to send guidance");
    } finally {
      setSendingGuidance(false);
    }
  };

  const runAction = async (kind: "start" | "retry" | "cancel", action: () => Promise<unknown>, failure: string) => {
    if (busy) return;
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(null);
    }
  };

  const handleRetry = () =>
    runAction(
      "retry",
      () =>
        onRetry({
          agentId: workOrder.agentId,
          objective: workOrder.objective,
          target: workOrder.target,
          priority: workOrder.priority,
          relatedAssets: workOrder.relatedAssets,
          relatedFindings: workOrder.relatedFindings,
          retryOf: workOrder.id,
        }),
      "Failed to retry the work order",
    );

  const duration = workOrder.startedAt ? (workOrder.completedAt ?? Date.now()) - workOrder.startedAt : undefined;
  // Findings this order touched: the ones it was created for, plus any recorded from its runs.
  const executionIds = new Set(task?.toolExecutionIds ?? []);
  const produced = findings.filter(
    (f) => workOrder.relatedFindings.includes(f.id) || f.executionIds.some((id) => executionIds.has(id)),
  );

  return (
    <GlassPanel padding="md">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={STATUS_TONE[workOrder.status]}>{workOrder.status.replace(/_/g, " ")}</StatusPill>
            {workOrder.noOutcome && (
              <StatusPill tone="warning" dot={false}>
                <span title="The agent answered without running or recording anything">no tool used</span>
              </StatusPill>
            )}
            {retried && <span className="text-[11px] text-muted">retried</span>}
            <span className="text-[11px] text-text">{agentName(agents, workOrder.agentId)}</span>
          </div>
          <p className={`mt-1.5 text-sm text-text ${open ? "" : "line-clamp-2"}`}>{workOrder.objective}</p>
          {workOrder.target && <p className="mt-0.5 font-mono text-xs text-muted">target: {workOrder.target}</p>}
          {workOrder.status === "failed" && (
            <Notice className="mt-1.5">{workOrder.result || "It failed without recording a reason."}</Notice>
          )}
          <p className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
            <span>created {relativeTime(workOrder.createdAt)}</span>
            {duration !== undefined && <span>· {workOrder.completedAt ? "took" : "running for"} {formatDuration(duration)}</span>}
            {workOrder.toolCallCount !== undefined && (
              <span>
                · {workOrder.toolCallCount} tool call{workOrder.toolCallCount === 1 ? "" : "s"}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {workOrder.status === "pending" && (
            <Button variant="primary" size="sm" icon={Play} onClick={() => runAction("start", () => onStart(workOrder.id), "Failed to start the work order")} disabled={!!busy}>
              {busy === "start" ? "Starting…" : "Start"}
            </Button>
          )}
          {(workOrder.status === "failed" || workOrder.status === "cancelled") && !retried && (
            <Button variant="secondary" size="sm" onClick={handleRetry} disabled={!!busy}>
              {busy === "retry" ? "Retrying…" : "Retry"}
            </Button>
          )}
          {NON_TERMINAL.includes(workOrder.status) && (
            <Button variant="secondary" size="sm" onClick={() => runAction("cancel", () => onCancel(workOrder.id), "Failed to cancel the work order")} disabled={!!busy}>
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          {workOrder.orchestratorTaskId && (
            <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide" : "Inspect"}
            </Button>
          )}
        </div>
      </div>

      {actionError && <Notice className="mt-2">{actionError}</Notice>}

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-border pt-2.5">
          {!task && !taskError && <SkeletonRows count={2} />}
          {taskError && <Notice>{taskError}</Notice>}

          {task?.status === "waiting_confirmation" && (
            <Notice tone="warning">
              Waiting on a tool approval - approve or reject it in the Factory dashboard's Needs you list, and the order
              carries on from there.
            </Notice>
          )}

          {task?.status === "waiting_guidance" && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-warning">
                The agent's last tool request failed, so there's nothing to approve. Give it a note to steer the retry,
                or leave it blank to just let it try again.
              </p>
              {lastToolProblem(task) && <p className="font-mono text-xs text-critical">{lastToolProblem(task)}</p>}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Note for the agent"
                placeholder="Optional note, e.g. subfinder isn't installed - use dig instead"
                rows={2}
                disabled={sendingGuidance}
                className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
              />
              {guidanceError && <Notice>{guidanceError}</Notice>}
              <div>
                <Button variant="primary" size="sm" onClick={handleSendGuidance} disabled={sendingGuidance}>
                  {sendingGuidance ? "Sending…" : "Continue"}
                </Button>
              </div>
            </div>
          )}

          {task && task.messages.length > 1 && <TaskTranscript task={task} />}

          {task?.finalResponse && (
            <div className="rounded-lg border border-border p-2.5">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Final answer</p>
              <Markdown content={task.finalResponse} />
            </div>
          )}
          {task && !task.finalResponse && !task.error && task.messages.length <= 1 && task.status !== "waiting_guidance" && task.status !== "waiting_confirmation" && (
            <p className="text-xs text-muted">No final response yet ({task.status}).</p>
          )}
          {task?.error && workOrder.status !== "failed" && <Notice>{task.error}</Notice>}

          {task && (task.toolExecutionIds.length > 0 || produced.length > 0) && (
            <div className="flex flex-col gap-1.5 text-xs">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Produced</p>
              {task.toolExecutionIds.length > 0 && (
                <p className="flex items-center gap-2 text-text">
                  {task.toolExecutionIds.length} tool run{task.toolExecutionIds.length === 1 ? "" : "s"}
                  {openView && (
                    <Button variant="ghost" size="sm" onClick={() => openView("tools")}>
                      Open in Tools history
                    </Button>
                  )}
                </p>
              )}
              {produced.length > 0 && (
                <div className="flex flex-col gap-1">
                  {produced.map((f) => (
                    <p key={f.id} className="text-text">
                      <span className="text-muted">{f.severity}</span> {f.title} <span className="text-muted">({f.status})</span>
                    </p>
                  ))}
                  {openView && (
                    <div>
                      <Button variant="ghost" size="sm" onClick={() => openView("findings")}>
                        Open Findings
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  );
}

/**
 * Every Security Work Order for the mission, grouped by status. A pending order can be started; a
 * paused one branches on its task's real status (a pending approval points at the dashboard, a
 * failed tool request takes a note here); a failed/cancelled one can be retried. Inspect shows the
 * whole transcript. New work order reaches any agent, including the ones the Director never seeds.
 */
export function WorkOrdersView({ mission, agents = [], active = true }: { mission: Mission | null; agents?: AgentWithStatus[]; active?: boolean }) {
  const missionId = mission?.id ?? null;
  const { workOrders, loading, error, refresh, refreshOne, create, start, cancel, guide } = useWorkOrders(missionId);
  const { findings } = useFindings(missionId);
  useRefreshOnActivate(active, refresh);
  const { openView } = useAppNav();
  const [creating, setCreating] = useState(false);

  const handleRetry = async (input: WorkOrderCreateInput) => {
    const created = await create(input);
    await start(created.id);
  };

  const handleCreate = async (input: WorkOrderCreateInput, startNow: boolean) => {
    const created = await create(input);
    if (startNow) await start(created.id);
  };

  const retriedIds = new Set(workOrders.map((w) => w.retryOf).filter(Boolean));

  const grouped = (["running", "waiting_approval", "queued", "pending", "completed", "failed", "cancelled"] as const)
    .map((status) => ({ status, items: workOrders.filter((w) => w.status === status) }))
    .filter((g) => g.items.length > 0);

  if (!mission) return <NoMission />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
          New work order
        </Button>
      </div>
      {error && <Notice>{error}</Notice>}
      {loading && workOrders.length === 0 && <SkeletonRows count={4} />}
      {!loading && workOrders.length === 0 && (
        <EmptyState icon={ClipboardList} title="No work orders yet" action={{ label: "Open the Factory", icon: Play, onClick: openView && (() => openView("factory")) }}>
          Advance the factory and the Director creates work orders from the mission's scope and what it finds - or
          create one yourself for any agent.
        </EmptyState>
      )}
      <div className="flex flex-col gap-4">
        {grouped.map((group) => (
          <div key={group.status}>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              {group.status.replace(/_/g, " ")} ({group.items.length})
            </p>
            <div className="flex flex-col gap-2">
              {group.items.map((w) => (
                <WorkOrderCard
                  key={w.id}
                  workOrder={w}
                  agents={agents}
                  findings={findings}
                  retried={retriedIds.has(w.id)}
                  onRefreshStatus={refreshOne}
                  onStart={start}
                  onRetry={handleRetry}
                  onCancel={cancel}
                  onGuide={guide}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <NewWorkOrderSheet open={creating} agents={agents} onClose={() => setCreating(false)} onCreate={handleCreate} />
    </div>
  );
}
