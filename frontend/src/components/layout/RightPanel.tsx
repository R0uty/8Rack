import { Gauge, MessagesSquare, Sliders } from "lucide-react";
import type { AgentWithStatus } from "../../types/agent";
import { iconFor } from "../../lib/icons";
import { GlassPanel, SectionHeading, StatusDot } from "../ui";

interface RightPanelProps {
  selectedAgent: AgentWithStatus | null;
  selectedModel: string | null;
  messageCount: number;
}

/** The Chat view's context panel: real agent/model detail and a real session readout — no
 * fabricated token/GPU/memory metrics (nothing in this app tracks those). */
export function RightPanel({ selectedAgent, selectedModel, messageCount }: RightPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <section>
        <SectionHeading>{selectedAgent ? "Active Agent" : "Active Model"}</SectionHeading>
        {selectedAgent ? (
          <AgentDetailCard agent={selectedAgent} />
        ) : (
          <GlassPanel padding="md">
            <div className="flex items-center gap-2 text-sm text-text">
              <Sliders size={14} className="text-muted" />
              {selectedModel ?? "No model selected"}
            </div>
            <p className="mt-2 text-xs text-muted">
              No agent selected — replies use this model directly with no system prompt.
            </p>
          </GlassPanel>
        )}
      </section>

      <section>
        <SectionHeading>Session</SectionHeading>
        <GlassPanel padding="md">
          <div className="flex items-center gap-2 text-sm text-text">
            <MessagesSquare size={14} className="text-muted" />
            {messageCount} message{messageCount === 1 ? "" : "s"}
          </div>
          <p className="mt-2 text-xs text-muted">Stored for this browser session only — cleared on tab close.</p>
        </GlassPanel>
      </section>
    </div>
  );
}

function AgentDetailCard({ agent }: { agent: AgentWithStatus }) {
  const Icon = iconFor(agent.icon);
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
        <Row label="Model" value={agent.model} mono />
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
