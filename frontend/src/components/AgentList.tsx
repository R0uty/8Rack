import type { CSSProperties } from "react";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import type { AgentConfigWarning, AgentWithStatus } from "../types/agent";
import { iconFor } from "../lib/icons";
import { FOCUS_RING, IconButton, SectionHeading, SkeletonRows, StatusDot } from "./ui";

interface AgentListProps {
  agents: AgentWithStatus[];
  loading: boolean;
  error: string | null;
  warnings: AgentConfigWarning[];
  /** Opens the AgentEditor sheet for this agent - a row click and this are the same action, there's
   * no longer a separate "chat with"/"edit" distinction now that Chat is gone. */
  onSelectAgent: (agent: AgentWithStatus) => void;
  onRefresh: () => void;
  /** Opens the AgentEditor sheet in create mode. */
  onCreateAgent: () => void;
}

export function AgentList({ agents, loading, error, warnings, onSelectAgent, onRefresh, onCreateAgent }: AgentListProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <SectionHeading
        actions={
          <div className="flex items-center gap-1">
            <IconButton icon={Plus} label="New agent" size="sm" onClick={onCreateAgent} />
            <IconButton
              icon={RefreshCw}
              label="Reload agent configs"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className={loading ? "animate-spin" : undefined}
            />
          </div>
        }
      >
        Agents
      </SectionHeading>

      {error && <p className="mb-2 text-xs text-critical">{error}</p>}
      {warnings.length > 0 && (
        <div
          className="mb-2 rounded-lg border border-warning/30 bg-warning-dim px-2.5 py-2 text-xs text-warning"
          title="Fix these files, then click refresh to reload"
        >
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertTriangle size={12} />
            {warnings.length} agent config file{warnings.length === 1 ? "" : "s"} failed to load
          </div>
          <ul className="space-y-0.5 opacity-90">
            {warnings.map((w) => (
              <li key={w.file}>
                <code>{w.file}</code> — {w.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!error && !loading && agents.length === 0 && <p className="text-xs text-muted">No agents found</p>}
      {loading && agents.length === 0 && <SkeletonRows count={4} />}

      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {agents.map((agent) => {
          const Icon = iconFor(agent.icon);
          const style = { "--agent-color": agent.color } as CSSProperties;
          return (
            <li key={agent.id}>
              <button
                type="button"
                style={style}
                onClick={() => onSelectAgent(agent)}
                title={agent.description}
                className={`group flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-all duration-150 hover:border-border hover:bg-card ${FOCUS_RING}`}
              >
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: "color-mix(in srgb, var(--agent-color) 18%, transparent)", color: agent.color }}
                >
                  <Icon size={14} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text">{agent.name}</span>
                    <StatusDot tone={agent.status === "online" ? "primary" : "neutral"} pulse={agent.status === "online"} />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{agent.description}</span>
                  <span className="mt-1 inline-block rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    {agent.model}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
