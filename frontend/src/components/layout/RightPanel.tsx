import { Gauge, Radio, Sliders } from "lucide-react";
import type { AgentWithStatus } from "../../types/agent";
import type { SessionMeta } from "../../hooks/useSessions";
import { iconFor } from "../../lib/icons";
import { GlassPanel, SectionHeading, StatusDot } from "../ui";

interface RightPanelProps {
  /** The agent behind the currently focused session, if any (null on the Home tab or a manual chat). */
  activeAgent: AgentWithStatus | null;
  /** The focused session's actual model — may differ from activeAgent.model if overridden. */
  activeModel: string | null;
  /** Every open session across both views, for the "what's running" readout below. */
  sessions: SessionMeta[];
}

/** The Chat view's context panel: real agent/model detail for whichever session is currently
 * focused, and a real readout of every session currently open across the app — no fabricated
 * token/GPU/memory metrics. */
export function RightPanel({ activeAgent, activeModel, sessions }: RightPanelProps) {
  const chatCount = sessions.filter((s) => s.kind === "chat").length;
  const taskCount = sessions.filter((s) => s.kind === "task").length;
  return (
    <div className="flex flex-col gap-4">
      <section>
        <SectionHeading>{activeAgent ? "Active Agent" : "Active Model"}</SectionHeading>
        {activeAgent ? (
          <AgentDetailCard agent={activeAgent} model={activeModel} />
        ) : (
          <GlassPanel padding="md">
            <div className="flex items-center gap-2 text-sm text-text">
              <Sliders size={14} className="text-muted" />
              {activeModel ?? "No model selected"}
            </div>
            <p className="mt-2 text-xs text-muted">
              No agent for this session — replies use this model directly with no system prompt.
            </p>
          </GlassPanel>
        )}
      </section>

      <section>
        <SectionHeading>Running</SectionHeading>
        <GlassPanel padding="md">
          <div className="flex items-center gap-2 text-sm text-text">
            <Radio size={14} className="text-muted" />
            {sessions.length === 0
              ? "No sessions open"
              : `${chatCount} chat${chatCount === 1 ? "" : "s"}, ${taskCount} task${taskCount === 1 ? "" : "s"}`}
          </div>
          <p className="mt-2 text-xs text-muted">
            Each agent can run a chat and a task at once — open more from the network map or a session's tab.
          </p>
        </GlassPanel>
      </section>
    </div>
  );
}

function AgentDetailCard({ agent, model }: { agent: AgentWithStatus; model: string | null }) {
  const Icon = iconFor(agent.icon);
  const overridden = !!model && model !== agent.model;
  return (
    <GlassPanel padding="md">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `color-mix(in srgb, ${agent.color} 18%, transparent)`, color: agent.color }}
        >
          <Icon size={16} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-text">{agent.name}</span>
            <StatusDot tone={agent.status === "online" ? "primary" : "neutral"} pulse={agent.status === "online"} />
          </div>
          <p className="mt-0.5 text-xs text-muted">{agent.description}</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs">
        <Row label="Model" value={model ?? agent.model} mono />
        {overridden && <Row label="Agent default" value={agent.model} mono />}
        <Row label="Temperature" value={agent.temperature.toFixed(2)} />
        <Row label="Top P" value={agent.topP.toFixed(2)} />
        <Row label="Max tokens" value={agent.maxTokens > 0 ? String(agent.maxTokens) : "model default"} />
      </div>
    </GlassPanel>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-muted">
        <Gauge size={11} />
        {label}
      </span>
      <span className={mono ? "font-mono text-text" : "text-text"}>{value}</span>
    </div>
  );
}
