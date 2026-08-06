import type { ExecToolWithStatus, ExecutionRecord, ExecutionStatus } from "../types/execTool";
import { iconFor, ToolFallbackIcon } from "../lib/icons";
import { GlassPanel, IconButton, SectionHeading, SkeletonRows, StatusPill, type Tone } from "./ui";
import { RefreshCw } from "lucide-react";

interface ToolRegistryProps {
  tools: ExecToolWithStatus[];
  executions: ExecutionRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const LAST_RUN_TONE: Record<ExecutionStatus, Tone> = {
  pending_confirmation: "warning",
  running: "info",
  completed: "primary",
  rejected: "neutral",
  cancelled: "neutral",
  failed: "critical",
};

/** executions is already newest-first from the backend, so the first match is the most recent. */
function lastExecutionFor(toolId: string, executions: ExecutionRecord[]): ExecutionRecord | undefined {
  return executions.find((e) => e.toolId === toolId);
}

export function ToolRegistry({ tools, executions, loading, error, onRefresh }: ToolRegistryProps) {
  return (
    <section>
      <SectionHeading
        actions={
          <IconButton
            icon={RefreshCw}
            label="Refresh tool list"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className={loading ? "animate-spin" : undefined}
          />
        }
      >
        Tool Registry
      </SectionHeading>

      {error && <p className="mb-2 text-xs text-critical">{error}</p>}
      {loading && tools.length === 0 && <SkeletonRows count={5} />}
      {!error && !loading && tools.length === 0 && <p className="text-xs text-muted">No tools registered</p>}

      <div className="flex flex-col gap-2">
        {tools.map((tool) => {
          const last = lastExecutionFor(tool.id, executions);
          const Icon = iconFor(tool.icon, ToolFallbackIcon);
          return (
            <GlassPanel key={tool.id} padding="sm" className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                <Icon size={13} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-text">{tool.name}</span>
                  <StatusPill tone={tool.availability === "available" ? "primary" : "neutral"} dot>
                    {tool.availability}
                  </StatusPill>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">{tool.description}</p>
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{tool.category}</span>
                  <span className="truncate font-mono" title={tool.resolvedPath ?? tool.executable}>
                    {tool.executable}
                  </span>
                  {last ? (
                    <StatusPill tone={LAST_RUN_TONE[last.status]} dot={false} className="ml-auto px-1.5 py-0.5">
                      {last.status}
                    </StatusPill>
                  ) : (
                    <span className="ml-auto italic text-muted">never run</span>
                  )}
                </div>
              </div>
            </GlassPanel>
          );
        })}
      </div>
    </section>
  );
}
