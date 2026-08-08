import { Bot, Wrench } from "lucide-react";
import type { ExecutionRecord, ExecutionStatus } from "../types/execTool";
import type { OrchestratorTask, TaskStatus } from "../types/orchestrator";
import type { AgentWithStatus } from "../types/agent";
import { relativeTime } from "../lib/relativeTime";
import { GlassPanel, SkeletonRows, StatusPill, type Tone } from "./ui";

interface ActivityFeedProps {
  executions: ExecutionRecord[];
  tasks: OrchestratorTask[];
  agents: AgentWithStatus[];
  loading: boolean;
  error: string | null;
}

type ActivityEntry =
  | { kind: "execution"; id: string; at: number; execution: ExecutionRecord }
  | { kind: "task"; id: string; at: number; task: OrchestratorTask };

function agentName(agents: AgentWithStatus[], agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

const EXECUTION_TONE: Record<ExecutionStatus, Tone> = {
  pending_confirmation: "warning",
  running: "info",
  completed: "primary",
  rejected: "neutral",
  cancelled: "neutral",
  failed: "critical",
};

const TASK_TONE: Record<TaskStatus, Tone> = {
  running: "info",
  waiting_confirmation: "warning",
  waiting_guidance: "warning",
  completed: "primary",
  failed: "critical",
  cancelled: "neutral",
  max_executions_reached: "critical",
  max_time_reached: "critical",
};

/**
 * Chronological feed merging a project's tool executions and Orchestrator task transcripts - the
 * task's "Activity log" ask (agent actions, tool executions, decisions, errors), built as a
 * client-side merge of two already-fetched lists rather than a new backend entity (see
 * DEVELOPMENT.md's Activity feed section).
 */
export function ActivityFeed({ executions, tasks, agents, loading, error }: ActivityFeedProps) {
  const entries: ActivityEntry[] = [
    ...executions.map((e): ActivityEntry => ({ kind: "execution", id: e.id, at: e.createdAt, execution: e })),
    ...tasks.map((t): ActivityEntry => ({ kind: "task", id: t.id, at: t.createdAt, task: t })),
  ].sort((a, b) => b.at - a.at);

  if (error) return <p className="text-xs text-critical">{error}</p>;
  if (loading && entries.length === 0) return <SkeletonRows count={5} />;
  if (entries.length === 0) return <p className="text-xs text-muted">No activity yet for this project.</p>;

  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry) =>
        entry.kind === "execution" ? (
          <GlassPanel key={`exec-${entry.id}`} padding="sm" className="flex items-center gap-2.5">
            <Wrench size={13} className="shrink-0 text-muted" />
            <StatusPill tone={EXECUTION_TONE[entry.execution.status]} dot={false} className="shrink-0 px-1.5 py-0.5">
              {entry.execution.status}
            </StatusPill>
            <span className="shrink-0 text-xs font-medium text-text">{entry.execution.toolId}</span>
            {agentName(agents, entry.execution.agentId) && (
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                {agentName(agents, entry.execution.agentId)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
              {entry.execution.resolvedCommand}
            </span>
            <span className="shrink-0 text-[11px] text-muted">{relativeTime(entry.at)}</span>
          </GlassPanel>
        ) : (
          <GlassPanel key={`task-${entry.id}`} padding="sm" className="flex items-center gap-2.5">
            <Bot size={13} className="shrink-0 text-muted" />
            <StatusPill tone={TASK_TONE[entry.task.status]} dot={false} className="shrink-0 px-1.5 py-0.5">
              {entry.task.status}
            </StatusPill>
            <span className="shrink-0 text-xs font-medium text-text">{agentName(agents, entry.task.agentId)}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{entry.task.objective}</span>
            {entry.task.error && (
              <span className="shrink-0 text-[11px] text-critical" title={entry.task.error}>
                error
              </span>
            )}
            <span className="shrink-0 text-[11px] text-muted">{relativeTime(entry.at)}</span>
          </GlassPanel>
        ),
      )}
    </div>
  );
}
