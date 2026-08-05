import type { CSSProperties } from "react";
import { motion } from "framer-motion";
import type { AgentWithStatus } from "../../types/agent";
import { iconFor } from "../../lib/icons";
import { cn } from "../../lib/cn";

interface AgentNetworkProps {
  agents: AgentWithStatus[];
  selectedAgentId: string | null;
  onSelectAgent: (agent: AgentWithStatus) => void;
}

/** The Chat view's empty-state "Command Center" - a radial network of the real configured
 * agents (name/icon/status/model, all real data). Connective lines + node entrance are purely
 * decorative motion; clicking a node reuses the same select/toggle-deselect behavior as the
 * sidebar agent list. Positions are computed, not fabricated telemetry. */
export function AgentNetwork({ agents, selectedAgentId, onSelectAgent }: AgentNetworkProps) {
  const total = agents.length;

  return (
    <div className="relative mx-auto h-[420px] w-full max-w-2xl">
      {total > 0 && (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {agents.map((agent, i) => {
            const { x, y } = nodePosition(i, total);
            return (
              <motion.line
                key={agent.id}
                x1={50}
                y1={50}
                x2={x}
                y2={y}
                stroke={agent.id === selectedAgentId ? agent.color : "rgb(255 255 255 / 0.12)"}
                strokeWidth={0.3}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.05 * i }}
              />
            );
          })}
        </svg>
      )}

      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-lg font-bold text-black shadow-[0_0_28px_rgba(0,230,118,0.5)]">
          8R
        </div>
        <span className="text-xs text-muted">Command Center</span>
      </div>

      {agents.map((agent, i) => {
        const { x, y } = nodePosition(i, total);
        const Icon = iconFor(agent.icon);
        const active = agent.id === selectedAgentId;
        return (
          <motion.button
            key={agent.id}
            type="button"
            onClick={() => onSelectAgent(agent)}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, delay: 0.06 * i + 0.15 }}
            whileHover={{ scale: 1.08 }}
            style={{ left: `${x}%`, top: `${y}%` }}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5"
            title={agent.description}
          >
            <span
              className={cn(
                "relative flex h-12 w-12 items-center justify-center rounded-xl border backdrop-blur-xl transition-all",
                active ? "border-[var(--agent-color)] shadow-[0_0_20px_var(--agent-color)]" : "border-border bg-card/70",
              )}
              style={
                {
                  "--agent-color": agent.color,
                  backgroundColor: active ? `color-mix(in srgb, ${agent.color} 20%, transparent)` : undefined,
                } as CSSProperties
              }
            >
              <Icon size={18} strokeWidth={2} color={agent.color} />
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg",
                  agent.status === "online" ? "bg-primary animate-pulse-dot" : "bg-muted",
                )}
              />
            </span>
            <span className="max-w-[92px] truncate text-center text-[11px] font-medium text-text">{agent.name}</span>
            <span className="max-w-[92px] truncate text-center font-mono text-[9px] text-muted">{agent.model}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

function nodePosition(index: number, total: number): { x: number; y: number } {
  const angle = (index / Math.max(total, 1)) * 2 * Math.PI - Math.PI / 2;
  const radiusX = 42;
  const radiusY = 40;
  return { x: 50 + radiusX * Math.cos(angle), y: 50 + radiusY * Math.sin(angle) };
}
