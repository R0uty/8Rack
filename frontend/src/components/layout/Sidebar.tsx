import { Bot, FactoryIcon, FileText, FolderKanban, ListChecks, Radar, ShieldAlert, Wrench } from "lucide-react";
import type { AgentConfigWarning, AgentWithStatus } from "../../types/agent";
import { AgentList } from "../AgentList";
import { FOCUS_RING, StatusPill } from "../ui";
import { cn } from "../../lib/cn";
import { type AppView, PRIMARY_VIEWS, VIEW_LABEL } from "./types";

interface SidebarProps {
  activeView: AppView;
  onChangeView: (view: AppView) => void;
  /** Switches to the Factory Dashboard — the only way back to it from anywhere else in the app
   * without hunting for the nav item. */
  onGoHome: () => void;

  agents: AgentWithStatus[];
  agentsLoading: boolean;
  agentsError: string | null;
  agentWarnings: AgentConfigWarning[];
  onSelectAgent: (agent: AgentWithStatus) => void;
  onRefreshAgents: () => void;
  onCreateAgent: () => void;

  ollamaStatus: "unknown" | "connected" | "unavailable";
}

const NAV_ICON: Record<AppView, typeof Bot> = {
  factory: FactoryIcon,
  missions: FolderKanban,
  assets: Radar,
  workorders: ListChecks,
  findings: ShieldAlert,
  reports: FileText,
  agents: Bot,
  tools: Wrench,
};

export function Sidebar(props: SidebarProps) {
  const { activeView, onChangeView, onGoHome, ollamaStatus } = props;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-surface/80 backdrop-blur-xl">
      <button
        type="button"
        onClick={onGoHome}
        title="Return to the Factory Dashboard"
        className={cn(
          "flex items-center gap-2.5 px-5 py-5 text-left transition-colors hover:bg-card",
          FOCUS_RING,
        )}
      >
        <img
          src="/8rack-icon.png"
          alt="8Rack"
          className="h-8 w-8 shrink-0 rounded-lg object-cover shadow-[0_0_16px_rgba(0,230,118,0.45)]"
        />
        <div>
          <div className="text-sm font-semibold leading-tight text-text">8Rack</div>
          <div className="text-[11px] leading-tight text-muted">Bug Bounty Factory</div>
        </div>
      </button>

      <nav className="flex flex-col gap-1 px-3 pb-4">
        {PRIMARY_VIEWS.map((view) => {
          const Icon = NAV_ICON[view];
          const active = view === activeView;
          return (
            <button
              key={view}
              type="button"
              onClick={() => onChangeView(view)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                FOCUS_RING,
                active ? "bg-primary-dim text-primary" : "text-muted hover:bg-card hover:text-text",
              )}
            >
              <Icon size={16} strokeWidth={2} />
              {VIEW_LABEL[view]}
            </button>
          );
        })}
      </nav>

      <div className="mx-3 mb-4 h-px bg-border" />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <AgentList
          agents={props.agents}
          loading={props.agentsLoading}
          error={props.agentsError}
          warnings={props.agentWarnings}
          onSelectAgent={props.onSelectAgent}
          onRefresh={props.onRefreshAgents}
          onCreateAgent={props.onCreateAgent}
        />
      </div>

      <div className="border-t border-border px-4 py-3.5">
        <StatusPill
          tone={ollamaStatus === "connected" ? "primary" : ollamaStatus === "unavailable" ? "critical" : "neutral"}
          pulse={ollamaStatus === "connected"}
        >
          Ollama {ollamaStatus}
        </StatusPill>
      </div>
    </aside>
  );
}
