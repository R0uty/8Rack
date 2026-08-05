import { MessageSquare, ServerCog, Workflow } from "lucide-react";
import type { OllamaModel } from "../../types/ollama";
import type { AgentConfigWarning, AgentWithStatus } from "../../types/agent";
import { ModelSelector } from "../ModelSelector";
import { AgentList } from "../AgentList";
import { StatusPill } from "../ui";
import { cn } from "../../lib/cn";
import { type AppView, VIEW_LABEL } from "./types";

interface SidebarProps {
  activeView: AppView;
  onChangeView: (view: AppView) => void;

  models: OllamaModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  onRefreshModels: () => void;
  modelLocked: boolean;

  agents: AgentWithStatus[];
  agentsLoading: boolean;
  agentsError: string | null;
  agentWarnings: AgentConfigWarning[];
  selectedAgentId: string | null;
  onSelectAgent: (agent: AgentWithStatus) => void;
  onRefreshAgents: () => void;

  ollamaStatus: "unknown" | "connected" | "unavailable";
}

const NAV_ICON: Record<AppView, typeof MessageSquare> = {
  chat: MessageSquare,
  workbench: ServerCog,
  plans: Workflow,
};

export function Sidebar(props: SidebarProps) {
  const { activeView, onChangeView, ollamaStatus, selectedModel } = props;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-surface/80 backdrop-blur-xl">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-black shadow-[0_0_16px_rgba(0,230,118,0.45)]">
          8R
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight text-text">8Rack</div>
          <div className="text-[11px] leading-tight text-muted">Local AI Workstation</div>
        </div>
      </div>

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
          disabled={props.modelLocked}
        />
        <AgentList
          agents={props.agents}
          loading={props.agentsLoading}
          error={props.agentsError}
          warnings={props.agentWarnings}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
          onRefresh={props.onRefreshAgents}
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
