import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { ExecutionConsole } from "./ExecutionConsole";
import { GlassPanel, StatusPill, type Tone } from "./ui";
import { relativeTime } from "../lib/relativeTime";
import { cn } from "../lib/cn";
import type { ExecutionRecord, ExecutionStatus } from "../types/execTool";
import type { AgentWithStatus } from "../types/agent";

interface ExecutionHistoryPanelProps {
  executions: ExecutionRecord[];
  loading: boolean;
  error: string | null;
  /** Resolves an execution's agentId to a display name - this view blends executions from every
   * agent (and manual, agent-less requests) in one flat list, unlike a single task session's own
   * view where the agent is already obvious from context. */
  agents: AgentWithStatus[];
}

function agentName(agents: AgentWithStatus[], agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

const STATUS_TONE: Record<ExecutionStatus, Tone> = {
  pending_confirmation: "warning",
  running: "info",
  completed: "primary",
  rejected: "neutral",
  cancelled: "neutral",
  failed: "critical",
};

/** Matches the search query against the tool id, requesting agent, resolved command, and output —
 * searching what a command *did* (and who ran it), not just what it was named, is the point of the
 * original design spec's Terminal "Search" ask. */
function matchesQuery(execution: ExecutionRecord, agentLabel: string | undefined, query: string): boolean {
  if (!query) return true;
  const haystack = [
    execution.toolId,
    agentLabel,
    execution.resolvedCommand,
    execution.result?.stdout,
    execution.result?.stderr,
  ]
    .filter((v): v is string => !!v)
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function HistoryRow({ execution, agentLabel }: { execution: ExecutionRecord; agentLabel?: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <GlassPanel padding="sm">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
          <ChevronDown
            size={13}
            className={cn("shrink-0 text-muted transition-transform duration-200", expanded && "rotate-180")}
          />
          <StatusPill tone={STATUS_TONE[execution.status]} dot={false} className="shrink-0 px-1.5 py-0.5">
            {execution.status}
          </StatusPill>
          <span className="shrink-0 text-xs font-medium text-text">{execution.toolId}</span>
          {agentLabel && (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted" title="Requested by">
              {agentLabel}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
            {execution.resolvedCommand}
          </span>
          <span className="shrink-0 text-[11px] text-muted">{relativeTime(execution.createdAt)}</span>
      </button>

      {expanded && (
        <div className="mt-2">
          <ExecutionConsole
            toolId={execution.toolId}
            resolvedCommand={execution.resolvedCommand}
            status={execution.status}
            result={execution.result}
            scopeWarning={execution.scopeWarning}
          />
        </div>
      )}
    </GlassPanel>
  );
}

/** A mission's tool runs, searchable by tool, agent, command, or output. */
export function ExecutionHistoryPanel({ executions, loading, error, agents }: ExecutionHistoryPanelProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return executions.filter((e) => matchesQuery(e, agentName(agents, e.agentId), q));
  }, [executions, query, agents]);

  return (
    <section>
      {error && <p className="mb-2 text-xs text-critical">{error}</p>}

      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tool, command, or output…"
            className="w-full rounded-lg border border-border bg-surface-2 py-1.5 pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </div>
      </div>

      {!error && !loading && executions.length === 0 && <p className="text-xs text-muted">No executions yet</p>}
      {!error && executions.length > 0 && filtered.length === 0 && (
        <p className="text-xs text-muted">No executions match.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {filtered.map((execution) => (
          <HistoryRow
            key={execution.id}
            execution={execution}
            agentLabel={agentName(agents, execution.agentId)}
          />
        ))}
      </div>
    </section>
  );
}
