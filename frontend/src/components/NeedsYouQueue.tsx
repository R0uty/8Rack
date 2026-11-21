import { useState } from "react";
import { AlertTriangle, Check, MessageSquare, RotateCcw, ShieldCheck, Square, X } from "lucide-react";
import { cancelExecution, confirmExecution, rejectExecution } from "../services/toolsApi";
import { createWorkOrder, guideWorkOrder, startWorkOrder } from "../services/workOrdersApi";
import { useMissionLive } from "../hooks/useMissionEvents";
import { useAppNav } from "../lib/appNav";
import { agentName } from "../lib/agentName";
import { needsYouCount } from "../lib/attention";
import type { AgentWithStatus } from "../types/agent";
import type { ApprovalItem, AttentionWorkOrder, GuidanceItem, MissionAttention } from "../types/attention";
import type { WorkOrder } from "../types/workOrder";
import { Button, GlassPanel, Notice, SectionHeading } from "./ui";

interface NeedsYouQueueProps {
  missionId: string;
  missionName: string;
  attention: MissionAttention;
  agents: AgentWithStatus[];
  /** After any action - the event stream refreshes too, this just doesn't wait for it. */
  onChanged: () => void;
}

function formatTimeout(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function OrderLine({ workOrder }: { workOrder?: AttentionWorkOrder }) {
  if (!workOrder) return null;
  return <p className="text-xs text-text">{workOrder.objective}</p>;
}

function AgentSays({ text }: { text?: string }) {
  if (!text) return null;
  return <blockquote className="border-l-2 border-border pl-2 text-xs italic text-muted">{text}</blockquote>;
}

function CardHeader({ label, tone, agent }: { label: string; tone: string; agent: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className={`text-xs font-medium uppercase tracking-wide ${tone}`}>{label}</span>
      <span className="text-[11px] text-muted">{agent}</span>
    </div>
  );
}

function ApprovalCard({ item, missionName, agents, busy, onApprove, onReject }: {
  item: ApprovalItem;
  missionName: string;
  agents: AgentWithStatus[];
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { execution, tool, targets, workOrder, agentText } = item;
  return (
    <GlassPanel padding="md" className="flex flex-col gap-2 border-warning/30">
      <CardHeader label="Requires approval" tone="text-warning" agent={agentName(agents, execution.agentId)} />
      <OrderLine workOrder={workOrder} />
      <AgentSays text={agentText} />
      <pre className="overflow-x-auto rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-xs text-text">$ {execution.resolvedCommand}</pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        {tool && (
          <>
            <dt className="text-muted">Tool</dt>
            <dd className="text-text">
              {tool.name} <span className="text-muted">- {tool.description}</span>
            </dd>
            <dt className="text-muted">Timeout</dt>
            <dd className="text-text">{formatTimeout(tool.timeoutMs)}</dd>
          </>
        )}
        <dt className="text-muted">Target</dt>
        <dd className="font-mono text-text">{targets.length ? targets.join(", ") : "none found in the arguments"}</dd>
        <dt className="text-muted">Mission</dt>
        <dd className="text-text">{missionName}</dd>
      </dl>
      {execution.scopeWarning ? (
        <p className="flex items-center gap-1 text-[11px] text-warning">
          <AlertTriangle size={11} aria-hidden />
          {execution.scopeWarning}
        </p>
      ) : (
        <p className="flex items-center gap-1 text-[11px] text-primary">
          <ShieldCheck size={11} aria-hidden />
          No scope warning
        </p>
      )}
      <div className="mt-1 flex gap-2">
        <Button variant="primary" size="sm" icon={Check} onClick={onApprove} disabled={busy}>
          Approve
        </Button>
        <Button variant="danger" size="sm" icon={X} onClick={onReject} disabled={busy}>
          Reject
        </Button>
      </div>
    </GlassPanel>
  );
}

function GuidanceCard({ item, agents, busy, onSend }: {
  item: GuidanceItem;
  agents: AgentWithStatus[];
  busy: boolean;
  onSend: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <GlassPanel padding="md" className="flex flex-col gap-2 border-warning/30">
      <CardHeader label="Needs a note" tone="text-warning" agent={agentName(agents, item.workOrder.agentId)} />
      <OrderLine workOrder={item.workOrder} />
      <p className="text-xs text-muted">Its last tool request failed, so there's nothing to approve. Steer the retry, or leave it blank to let it try again.</p>
      {item.problem && <pre className="whitespace-pre-wrap font-mono text-xs text-critical">{item.problem}</pre>}
      <AgentSays text={item.agentText} />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label={`Note for ${agentName(agents, item.workOrder.agentId)}`}
        placeholder="Optional note, e.g. subfinder isn't installed - use dig instead"
        rows={2}
        disabled={busy}
        className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
      />
      <div>
        <Button variant="primary" size="sm" icon={MessageSquare} onClick={() => onSend(note.trim())} disabled={busy}>
          Continue
        </Button>
      </div>
    </GlassPanel>
  );
}

function FailedCard({ workOrder, agents, busy, onRetry, onView }: {
  workOrder: WorkOrder;
  agents: AgentWithStatus[];
  busy: boolean;
  onRetry: () => void;
  onView?: () => void;
}) {
  return (
    <GlassPanel padding="md" className="flex flex-col gap-2 border-critical/30">
      <CardHeader label="Failed" tone="text-critical" agent={agentName(agents, workOrder.agentId)} />
      <OrderLine workOrder={workOrder} />
      <p className="text-xs text-critical">{workOrder.result || "It failed without recording a reason."}</p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" icon={RotateCcw} onClick={onRetry} disabled={busy}>
          Retry
        </Button>
        {onView && (
          <Button variant="ghost" size="sm" onClick={onView}>
            Open in Work Orders
          </Button>
        )}
      </div>
    </GlassPanel>
  );
}

/**
 * Everything on the mission waiting on a human, in one list: tool approvals (with what the tool is,
 * what it targets, the order it serves and what the agent said), orders paused for a note, and
 * failed orders. Approved runs stay here while they run, with live output and Cancel. Every action
 * resumes the run on the server.
 */
export function NeedsYouQueue({ missionId, missionName, attention, agents, onChanged }: NeedsYouQueueProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { executionOutput } = useMissionLive(missionId);
  const { openView } = useAppNav();

  const act = async (id: string, action: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusyId(null);
    }
  };

  const retry = async (wo: WorkOrder) => {
    const created = await createWorkOrder(missionId, {
      agentId: wo.agentId,
      objective: wo.objective,
      target: wo.target,
      priority: wo.priority,
      relatedAssets: wo.relatedAssets,
      relatedFindings: wo.relatedFindings,
      retryOf: wo.id,
    });
    await startWorkOrder(missionId, created.id);
  };

  const count = needsYouCount(attention);
  const { approvals, running, guidance, failed } = attention;

  return (
    <section aria-labelledby="needs-you-heading">
      {/* Announced when the count changes - new approvals were silent to screen readers before. */}
      <p className="sr-only" aria-live="polite">
        {count === 0 ? "Nothing needs you." : `${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you.`}
      </p>
      {(count > 0 || running.length > 0) && (
        <SectionHeading>
          <span id="needs-you-heading">Needs you ({count})</span>
        </SectionHeading>
      )}
      {error && <Notice className="mb-2">{error}</Notice>}
      <div className="flex flex-col gap-2">
        {approvals.map((item) => (
          <ApprovalCard
            key={item.execution.id}
            item={item}
            missionName={missionName}
            agents={agents}
            busy={busyId === item.execution.id}
            onApprove={() => act(item.execution.id, () => confirmExecution(item.execution.id), "Failed to confirm execution")}
            onReject={() => act(item.execution.id, () => rejectExecution(item.execution.id), "Failed to reject execution")}
          />
        ))}
        {guidance.map((item) => (
          <GuidanceCard
            key={item.workOrder.id}
            item={item}
            agents={agents}
            busy={busyId === item.workOrder.id}
            onSend={(note) => act(item.workOrder.id, () => guideWorkOrder(missionId, item.workOrder.id, note || undefined), "Failed to send the note")}
          />
        ))}
        {failed.map((wo) => (
          <FailedCard
            key={wo.id}
            workOrder={wo}
            agents={agents}
            busy={busyId === wo.id}
            onRetry={() => act(wo.id, () => retry(wo), "Failed to retry the work order")}
            onView={openView && (() => openView("workorders"))}
          />
        ))}
        {running.map(({ execution, workOrder }) => (
          <GlassPanel key={execution.id} padding="md" className="flex flex-col gap-2 border-info/30">
            <CardHeader label="Running" tone="text-info" agent={agentName(agents, execution.agentId)} />
            <OrderLine workOrder={workOrder} />
            <pre className="overflow-x-auto rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-xs text-text">$ {execution.resolvedCommand}</pre>
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-muted">
              {executionOutput[execution.id] || "No output yet."}
            </pre>
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon={Square}
                onClick={() => act(execution.id, () => cancelExecution(execution.id), "Failed to cancel execution")}
                disabled={busyId === execution.id}
              >
                Cancel
              </Button>
            </div>
          </GlassPanel>
        ))}
      </div>
    </section>
  );
}
