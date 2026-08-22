import { useState } from "react";
import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import { confirmExecution, rejectExecution } from "../services/toolsApi";
import type { AgentWithStatus } from "../types/agent";
import type { ExecutionRecord } from "../types/execTool";
import { Button, GlassPanel, SectionHeading } from "./ui";

interface ApprovalQueueProps {
  missionName: string;
  executions: ExecutionRecord[];
  agents: AgentWithStatus[];
  onSettled: () => void;
}

function agentName(agents: AgentWithStatus[], agentId: string | undefined): string {
  if (!agentId) return "Manual request";
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

/**
 * Aggregates every pending-confirmation ExecutionRecord for the current mission into one prominent
 * queue - the spec's "ACTION REQUIRES APPROVAL" mockup (agent, exact command, target/mission,
 * scope status, Approve/Reject). Reuses the existing confirm/reject calls (toolsApi.ts) the
 * Workbench/ExecutionConsole flow already drives - this is a new aggregated *view* over the same
 * human-in-the-loop gate, not a new approval mechanism.
 */
export function ApprovalQueue({ missionName, executions, agents, onSettled }: ApprovalQueueProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = executions.filter((e) => e.status === "pending_confirmation");

  const handleApprove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await confirmExecution(id, () => {});
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm execution");
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await rejectExecution(id);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject execution");
    } finally {
      setBusyId(null);
    }
  };

  if (pending.length === 0) {
    return (
      <section>
        <SectionHeading>Approval Queue</SectionHeading>
        <p className="text-xs text-muted">No actions awaiting approval for this mission.</p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Approval Queue ({pending.length})</SectionHeading>
      {error && <p className="mb-2 text-xs text-critical">{error}</p>}
      <div className="flex flex-col gap-2">
        {pending.map((execution) => (
          <GlassPanel key={execution.id} padding="md" className="border-warning/30">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-warning">Requires approval</span>
              <span className="text-[11px] text-muted">{agentName(agents, execution.agentId)}</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-xs text-text">
              $ {execution.resolvedCommand}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span>
                Mission: <span className="text-text">{missionName}</span>
              </span>
              {execution.scopeWarning ? (
                <span className="flex items-center gap-1 text-warning">
                  <AlertTriangle size={11} />
                  {execution.scopeWarning}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-primary">
                  <ShieldCheck size={11} />
                  In scope
                </span>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={Check}
                onClick={() => handleApprove(execution.id)}
                disabled={busyId === execution.id}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={X}
                onClick={() => handleReject(execution.id)}
                disabled={busyId === execution.id}
              >
                Reject
              </Button>
            </div>
          </GlassPanel>
        ))}
      </div>
    </section>
  );
}
