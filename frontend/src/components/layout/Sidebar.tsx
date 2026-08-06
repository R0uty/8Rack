import { MessageSquare, ServerCog, ShieldAlert, Workflow } from "lucide-react";
import type { OllamaModel } from "../../types/ollama";
import type { AgentConfigWarning, AgentWithStatus } from "../../types/agent";
import { ModelSelector } from "../ModelSelector";
import { AgentList } from "../AgentList";
import { FOCUS_RING, StatusPill } from "../ui";
import { cn } from "../../lib/cn";
import { type AppView, VIEW_LABEL } from "./types";

interface SidebarProps {
  activeView: AppView;
  onChangeView: (view: AppView) => void;
  /** Switches to Chat and focuses its Home tab — the only way back to the Command Center map from
   * anywhere else in the app (Workbench, Plans, or a chat session tab). */
  onGoHome: () => void;

  models: OllamaModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** The model picked for the next manual (no-agent) chat — no longer a global lock target. */
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  onRefreshModels: () => void;

  agents: AgentWithStatus[];
  agentsLoading: boolean;
  agentsError: string | null;
  agentWarnings: AgentConfigWarning[];
  activeAgentIds: ReadonlySet<string>;
  onSelectAgent: (agent: AgentWithStatus) => void;
  onRefreshAgents: () => void;
  onCreateAgent: () => void;
  onEditAgent: (agent: AgentWithStatus) => void;

  ollamaStatus: "unknown" | "connected" | "unavailable";
}

const NAV_ICON: Record<AppView, typeof MessageSquare> = {
  chat: MessageSquare,
  workbench: ServerCog,
  plans: Workflow,
  findings: ShieldAlert,
};

export function Sidebar(props: SidebarProps) {
  const { activeView, onChangeView, onGoHome, ollamaStatus, selectedModel } = props;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-surface/80 backdrop-blur-xl">
      <button
        type="button"
        onClick={onGoHome}
        title="Return to Command Center"
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
          <div className="text-[11px] leading-tight text-muted">Local AI Workstation</div>
        </div>
      </button>

      <nav className="flex flex-col gap-1 px-3 pb-4">
        {(Object.keys(VIEW_LABEL) as AppView[]).map((view) => {
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
        <ModelSelector
          models={props.models}
          loading={props.modelsLoading}
          error={props.modelsError}
          selectedModel={props.selectedModel}
          onSelectModel={props.onSelectModel}
          onRefresh={props.onRefreshModels}
        />
        <AgentList
          agents={props.agents}
          loading={props.agentsLoading}
          error={props.agentsError}
          warnings={props.agentWarnings}
          activeAgentIds={props.activeAgentIds}
          onSelectAgent={props.onSelectAgent}
          onRefresh={props.onRefreshAgents}
          onCreateAgent={props.onCreateAgent}
          onEditAgent={props.onEditAgent}
        />
      </div>

      <div className="border-t border-border px-4 py-3.5">
        <div className="flex items-center justify-between">
          <StatusPill
            tone={ollamaStatus === "connected" ? "primary" : ollamaStatus === "unavailable" ? "critical" : "neutral"}
            pulse={ollamaStatus === "connected"}
          >
            Ollama {ollamaStatus}
          </StatusPill>
        </div>
        <div className="mt-2 truncate font-mono text-[11px] text-muted" title={selectedModel ?? undefined}>
          {selectedModel ?? "No model selected"}
        </div>
      </div>
    </aside>
  );
}
