import { Check } from "lucide-react";
import type { Mission, MissionStatus } from "../types/mission";
import type { WorkOrder } from "../types/workOrder";
import type { Finding } from "../types/finding";
import { cn } from "../lib/cn";
import { SectionHeading, StatusPill } from "./ui";

interface PipelineStage {
  label: string;
  /** Non-terminal work orders whose agentId suggests this stage - just for the "active agents"
   * count shown under a stage, best-effort (a WorkOrder doesn't carry an explicit "stage" field). */
  agentIds: string[];
}

const STAGES: PipelineStage[] = [
  { label: "Scope", agentIds: [] },
  { label: "Recon", agentIds: ["recon-agent"] },
  { label: "Asset Discovery", agentIds: ["recon-agent"] },
  { label: "Enumeration", agentIds: ["web-analyzer", "recon-agent"] },
  { label: "Analysis", agentIds: ["web-analyzer", "code-assistant", "output-parser"] },
  { label: "Vulnerability Discovery", agentIds: ["web-analyzer", "code-assistant"] },
  { label: "Validation", agentIds: ["vulnerability-validator"] },
  { label: "Evidence", agentIds: ["vulnerability-validator"] },
  { label: "Report", agentIds: ["report-writer"] },
  { label: "Human Review", agentIds: [] },
];

/** Maps a mission's current pipeline status to the [start, end] range of stage indexes it's
 * "currently in" - draft/ready sit at Scope alone; every other active status spans two adjacent
 * stages (recon covers both Recon and Asset Discovery, etc.) since one MissionStatus value is
 * coarser than the 10-stage visual breakdown the spec asks for. Everything before the range reads
 * as done, everything after as pending. */
function stageRangeFor(status: MissionStatus | undefined): [number, number] | null {
  switch (status) {
    case undefined:
    case "draft":
    case "ready":
      return [0, 0];
    case "recon":
      return [1, 2];
    case "investigating":
      return [3, 4];
    case "validating":
      return [5, 6];
    case "reporting":
      return [7, 8];
    case "review":
    case "completed":
      return [9, 9];
    // paused/cancelled: no active range - render every stage neutral instead.
    default:
      return null;
  }
}

interface FactoryPipelineProps {
  mission: Mission;
  workOrders: WorkOrder[];
  findings: Finding[];
}

/**
 * The spec's 10-stage visual pipeline (Scope -> ... -> Human Review). Purely a derived view over
 * the mission's own `status` plus its work orders/findings - no new backend state, embedded as a
 * FactoryDashboard section rather than its own nav item (the plan doesn't list it as one).
 */
export function FactoryPipeline({ mission, workOrders, findings }: FactoryPipelineProps) {
  const range = stageRangeFor(mission.status);
  const nonTerminal = workOrders.filter((w) => w.status === "running" || w.status === "waiting_approval");
  const failed = workOrders.some((w) => w.status === "failed");
  const unsettledFindings = findings.filter((f) => f.status === "potential" || f.status === "investigating").length;

  return (
    <section>
      <SectionHeading>Factory Pipeline</SectionHeading>
      {range === null && (
        <p className="mb-2 text-xs text-warning">
          Mission is {mission.status} - stage progress is paused.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STAGES.map((stage, i) => {
          const done = range !== null && i < range[0];
          const current = range !== null && i >= range[0] && i <= range[1];
          const activeAgents = nonTerminal.filter((w) => stage.agentIds.includes(w.agentId)).length;
          return (
            <div
              key={stage.label}
              className={cn(
                "rounded-lg border px-2.5 py-2 text-center transition-colors",
                current ? "border-primary/50 bg-primary-dim" : done ? "border-border bg-card" : "border-border/50 bg-surface-2/50",
              )}
            >
              <div className="mb-1 flex items-center justify-center gap-1">
                {done && <Check size={11} className="text-primary" />}
                <span className={cn("text-[11px] font-medium", current ? "text-primary" : done ? "text-text" : "text-muted")}>
                  {stage.label}
                </span>
              </div>
              {current && activeAgents > 0 && (
                <StatusPill tone="info" dot={false} className="px-1.5 py-0.5 text-[10px]">
                  {activeAgents} active
                </StatusPill>
              )}
              {current && stage.label === "Validation" && unsettledFindings > 0 && (
                <p className="mt-0.5 text-[10px] text-muted">{unsettledFindings} pending</p>
              )}
              {current && failed && <p className="mt-0.5 text-[10px] text-critical">work order failed</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
