import type { CSSProperties } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Wrench } from "lucide-react";
import type { AgentWithStatus } from "../../types/agent";
import type { Project } from "../../types/project";
import type { SessionMeta } from "../../hooks/useSessions";
import { iconFor } from "../../lib/icons";
import { cn } from "../../lib/cn";
import type { Tone } from "../ui";

interface AgentNetworkProps {
  agents: AgentWithStatus[];
  /** All open sessions, both kinds - each renders as a small node connected to its parent agent
   * (or to the hub, for a manual/no-agent chat). */
  sessions: SessionMeta[];
  /** Resolves a project-scoped chat session's projectId to a name for its tooltip - see SessionNode. */
  projects: Project[];
  statuses: Record<string, Tone>;
  /** Opens/focuses a chat session for the clicked agent - the default "start working with this
   * agent" gesture. */
  onSelectAgent: (agent: AgentWithStatus) => void;
  /** Focuses an existing session's tab - the caller switches view first if it's a task session and
   * the Workbench isn't currently showing. */
  onSelectSession: (session: SessionMeta) => void;
}

const TONE_COLOR: Record<Tone, string> = {
  primary: "var(--color-primary)",
  info: "var(--color-info)",
  warning: "var(--color-warning)",
  critical: "var(--color-critical)",
  neutral: "var(--color-muted)",
};

/** The Chat view's Home tab - a live map of the real configured agents plus every currently open
 * session (see hooks/useSessions.ts), each rendered as a node connected to its parent agent (or,
 * for a manual/no-agent chat, to the center hub). New nodes/lines appear the moment a session
 * opens and disappear when it closes - this is a direct visualization of `sessions`, not a
 * separate decorative state. */
export function AgentNetwork({ agents, sessions, projects, statuses, onSelectAgent, onSelectSession }: AgentNetworkProps) {
  const total = agents.length;
  const manualSessions = sessions.filter((s) => s.agentId === null);

  return (
    <div className="relative mx-auto h-[460px] w-full max-w-2xl">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {agents.map((agent, i) => {
          const { x, y } = agentNodePosition(i, total);
          const agentSessions = sessions.filter((s) => s.agentId === agent.id);
          return (
            <g key={agent.id}>
              <motion.line
                x1={50}
                y1={50}
                x2={x}
                y2={y}
                stroke={agentSessions.length > 0 ? agent.color : "rgb(255 255 255 / 0.12)"}
                strokeWidth={0.3}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.05 * i }}
              />
              {agentSessions.map((session, si) => {
                const { x: sx, y: sy } = sessionNodePosition(i, total, si, agentSessions.length);
                const tone = statuses[session.id] ?? "neutral";
                return (
                  <motion.line
                    key={session.id}
                    x1={x}
                    y1={y}
                    x2={sx}
                    y2={sy}
                    stroke={TONE_COLOR[tone]}
                    strokeWidth={0.25}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.4 }}
                  />
                );
              })}
            </g>
          );
        })}

        {manualSessions.map((session, i) => {
          const { x, y } = manualSessionPosition(i);
          const tone = statuses[session.id] ?? "neutral";
          return (
            <motion.line
              key={session.id}
              x1={50}
              y1={50}
              x2={x}
              y2={y}
              stroke={TONE_COLOR[tone]}
              strokeWidth={0.25}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.4 }}
            />
          );
        })}
      </svg>

      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
        <img
          src="/8rack-icon.png"
          alt="8Rack"
          className="h-14 w-14 rounded-2xl object-cover shadow-[0_0_28px_rgba(0,230,118,0.5)]"
        />
        <span className="text-xs text-muted">Command Center</span>
      </div>

      {agents.map((agent, i) => {
        const { x, y } = agentNodePosition(i, total);
        const Icon = iconFor(agent.icon);
        const agentSessions = sessions.filter((s) => s.agentId === agent.id);
        const active = agentSessions.length > 0;
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

      {agents.map((agent, i) => {
        const agentSessions = sessions.filter((s) => s.agentId === agent.id);
        return agentSessions.map((session, si) => (
          <SessionNode
            key={session.id}
            session={session}
            projects={projects}
            position={sessionNodePosition(i, total, si, agentSessions.length)}
            tone={statuses[session.id] ?? "neutral"}
            color={agent.color}
            onClick={() => onSelectSession(session)}
          />
        ));
      })}

      {manualSessions.map((session, i) => (
        <SessionNode
          key={session.id}
          session={session}
          projects={projects}
          position={manualSessionPosition(i)}
          tone={statuses[session.id] ?? "neutral"}
          color="var(--color-muted)"
          onClick={() => onSelectSession(session)}
        />
      ))}
    </div>
  );
}

function SessionNode({
  session,
  projects,
  position,
  tone,
  color,
  onClick,
}: {
  session: SessionMeta;
  projects: Project[];
  position: { x: number; y: number };
  tone: Tone;
  color: string;
  onClick: () => void;
}) {
  const Icon = session.kind === "task" ? Wrench : MessageSquare;
  const project = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
  const title =
    session.kind === "task"
      ? (session.initialObjective ?? "Task session")
      : project
        ? `Chat session · ${project.name}`
        : "Chat session";
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.4 }}
      transition={{ duration: 0.25 }}
      whileHover={{ scale: 1.15 }}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      title={title}
    >
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full border backdrop-blur-xl"
        style={{ borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 22%, transparent)` }}
      >
        <Icon size={10} color={color} />
      </span>
      <span
        className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-bg"
        style={{ backgroundColor: TONE_COLOR[tone] }}
      />
    </motion.button>
  );
}

function agentNodePosition(index: number, total: number): { x: number; y: number } {
  const angle = (index / Math.max(total, 1)) * 2 * Math.PI - Math.PI / 2;
  return { x: 50 + 38 * Math.cos(angle), y: 50 + 36 * Math.sin(angle) };
}

function sessionNodePosition(
  agentIndex: number,
  totalAgents: number,
  siblingIndex: number,
  siblingCount: number,
): { x: number; y: number } {
  const baseAngle = (agentIndex / Math.max(totalAgents, 1)) * 2 * Math.PI - Math.PI / 2;
  const spread = siblingCount > 1 ? 0.22 : 0;
  const angle = baseAngle + (siblingIndex - (siblingCount - 1) / 2) * spread;
  return { x: 50 + 50 * Math.cos(angle), y: 50 + 47 * Math.sin(angle) };
}

function manualSessionPosition(index: number): { x: number; y: number } {
  return { x: 50, y: 50 + 24 + index * 9 };
}
