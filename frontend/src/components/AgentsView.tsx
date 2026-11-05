import type { CSSProperties } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { AgentConfigWarning, AgentWithStatus } from "../types/agent";
import type { ExecToolWithStatus } from "../types/execTool";
import { iconFor } from "../lib/icons";
import { AgentToolAccess } from "./AgentToolAccess";
import { Button, GlassPanel, IconButton, SkeletonRows, StatusDot } from "./ui";

interface AgentsViewProps {
  agents: AgentWithStatus[];
  loading: boolean;
  error: string | null;
  warnings: AgentConfigWarning[];
  execTools: ExecToolWithStatus[];
  onRefresh: () => void;
  onCreateAgent: () => void;
  onEditAgent: (agent: AgentWithStatus) => void;
}

/** Every agent's role, model, and any tool restrictions - and where agents get created and edited. */
export function AgentsView({ agents, loading, error, warnings, execTools, onRefresh, onCreateAgent, onEditAgent }: AgentsViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-1.5">
        <IconButton
          icon={RefreshCw}
          label="Reload agent configs"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className={loading ? "animate-spin" : undefined}
        />
        <Button variant="primary" size="sm" icon={Plus} onClick={onCreateAgent}>
          New agent
        </Button>
      </div>

      {error && <p className="text-xs text-critical">{error}</p>}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning-dim px-2.5 py-2 text-xs text-warning">
          <p className="mb-1 font-medium">
            {warnings.length} agent config file{warnings.length === 1 ? "" : "s"} failed to load
          </p>
          <ul className="space-y-0.5 opacity-90">
            {warnings.map((w) => (
              <li key={w.file}>
                <code>{w.file}</code> - {w.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading && agents.length === 0 && <SkeletonRows count={4} />}
      {!loading && !error && agents.length === 0 && <p className="text-xs text-muted">No agents found.</p>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {agents.map((agent) => {
          const Icon = iconFor(agent.icon);
          const style = { "--agent-color": agent.color } as CSSProperties;
          return (
            <GlassPanel key={agent.id} padding="md" style={style}>
              <div className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: "color-mix(in srgb, var(--agent-color) 18%, transparent)", color: agent.color }}
                >
                  <Icon size={15} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate text-sm font-medium text-text">
                      {agent.name}
                      <StatusDot tone={agent.status === "online" ? "primary" : "neutral"} pulse={agent.status === "online"} />
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => onEditAgent(agent)}>
                      Edit
                    </Button>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{agent.description}</p>
                  <span className="mt-1.5 inline-block rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    {agent.model}
                  </span>
                </div>
              </div>
              {agent.execTools !== undefined && (
                <div className="mt-3 border-t border-border pt-2.5">
                  <AgentToolAccess agent={agent} tools={execTools} />
                </div>
              )}
            </GlassPanel>
          );
        })}
      </div>
    </div>
  );
}
