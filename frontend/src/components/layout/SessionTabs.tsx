import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { SessionMeta } from "../../hooks/useSessions";
import type { AgentWithStatus } from "../../types/agent";
import { iconFor } from "../../lib/icons";
import { cn } from "../../lib/cn";
import { FOCUS_RING, StatusDot, type Tone } from "../ui";

interface SessionTabsProps {
  sessions: SessionMeta[];
  /** null = the Home tab is active. */
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  agents: AgentWithStatus[];
  statuses: Record<string, Tone>;
  homeIcon: LucideIcon;
  homeLabel: string;
}

/** Tab strip shared by the Chat and Workbench views - one tab per open session (see
 * hooks/useSessions.ts), plus a permanent non-closable Home tab. Each session's live status dot
 * comes from `statuses`, reported by whichever panel owns that session's real state. */
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onClose,
  agents,
  statuses,
  homeIcon: HomeIcon,
  homeLabel,
}: SessionTabsProps) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors",
          FOCUS_RING,
          activeId === null
            ? "border-primary text-text"
            : "border-transparent text-muted hover:text-text",
        )}
      >
        <HomeIcon size={13} />
        {homeLabel}
      </button>

      <AnimatePresence initial={false}>
        {sessions.map((session) => {
          const agent = session.agentId ? agents.find((a) => a.id === session.agentId) : undefined;
          const Icon = agent ? iconFor(agent.icon) : HomeIcon;
          const color = agent?.color ?? "var(--color-muted)";
          const agentLabel = agent?.name ?? "Manual chat";
          // Task sessions no longer dedup one-per-agent (see hooks/useSessions.ts), so two tabs can
          // share an agent name - fold in the objective so they're distinguishable at a glance; the
          // full text still shows via the title tooltip below since the tab itself truncates.
          const label = session.kind === "task" && session.initialObjective
            ? `${agentLabel}: ${session.initialObjective}`
            : agentLabel;
          const active = session.id === activeId;
          const tone = statuses[session.id];

          return (
            <motion.div
              key={session.id}
              layout
              initial={{ opacity: 0, scale: 0.9, width: 0 }}
              animate={{ opacity: 1, scale: 1, width: "auto" }}
              exit={{ opacity: 0, scale: 0.9, width: 0 }}
              transition={{ duration: 0.15 }}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 overflow-hidden rounded-t-lg border-b-2 py-2 pl-3 pr-2 text-xs font-medium transition-colors",
                active ? "border-primary text-text" : "border-transparent text-muted hover:text-text",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                className={cn("flex items-center gap-1.5 whitespace-nowrap", FOCUS_RING)}
                title={label}
              >
                <Icon size={13} color={color} />
                <span className="max-w-[110px] truncate">{label}</span>
                {tone && <StatusDot tone={tone} pulse={tone === "info"} />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.id);
                }}
                title="Close"
                className={cn(
                  "rounded p-0.5 opacity-0 transition-opacity hover:text-critical focus-visible:opacity-100 group-hover:opacity-100",
                  FOCUS_RING,
                )}
              >
                <X size={11} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
