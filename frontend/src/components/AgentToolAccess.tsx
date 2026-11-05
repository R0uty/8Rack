import { Check, X } from "lucide-react";
import type { Agent } from "../types/agent";
import type { ExecToolWithStatus } from "../types/execTool";

interface AgentToolAccessProps {
  agent: Pick<Agent, "execTools">;
  tools: ExecToolWithStatus[];
}

/**
 * Compact "allowed vs. restricted" list for one agent's Orchestrator tool access
 * (Agent.execTools, enforced server-side in orchestrator.ts - see CLAUDE.md's "Two tool-calling
 * mechanisms"). `execTools === undefined` means unrestricted (every tool allowed); an empty array
 * means none. Reused inside AgentEditor (live preview while editing) and AgentsView (browsing).
 */
export function AgentToolAccess({ agent, tools }: AgentToolAccessProps) {
  if (agent.execTools === undefined) {
    return (
      <p className="text-xs text-muted">
        <Check size={12} className="mr-1 inline text-primary" />
        Unrestricted — every enabled tool is available to this agent.
      </p>
    );
  }

  const allowedIds = new Set(agent.execTools);
  const allowed = tools.filter((t) => allowedIds.has(t.id));
  const restricted = tools.filter((t) => !allowedIds.has(t.id));

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Allowed ({allowed.length})
        </p>
        {allowed.length === 0 && <p className="text-xs text-muted">None</p>}
        <ul className="flex flex-col gap-0.5">
          {allowed.map((t) => (
            <li key={t.id} className="flex items-center gap-1.5 text-xs text-text">
              <Check size={12} className="shrink-0 text-primary" />
              <span className="truncate">{t.name}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Restricted ({restricted.length})
        </p>
        {restricted.length === 0 && <p className="text-xs text-muted">None</p>}
        <ul className="flex flex-col gap-0.5">
          {restricted.map((t) => (
            <li key={t.id} className="flex items-center gap-1.5 text-xs text-muted">
              <X size={12} className="shrink-0 text-critical" />
              <span className="truncate">{t.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
