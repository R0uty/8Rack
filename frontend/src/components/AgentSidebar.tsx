import type { OllamaModel } from "../types/ollama";
import type { AgentWithStatus } from "../types/agent";
import { ModelSelector } from "./ModelSelector";
import { AgentList } from "./AgentList";

interface AgentSidebarProps {
  models: OllamaModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  onRefreshModels: () => void;
  /** True while an agent is selected — the agent's own model becomes authoritative. */
  modelLocked: boolean;
  agents: AgentWithStatus[];
  agentsLoading: boolean;
  agentsError: string | null;
  selectedAgentId: string | null;
  onSelectAgent: (agent: AgentWithStatus) => void;
  onRefreshAgents: () => void;
}

export function AgentSidebar({
  models,
  modelsLoading,
  modelsError,
  selectedModel,
  onSelectModel,
  onRefreshModels,
  modelLocked,
  agents,
  agentsLoading,
  agentsError,
  selectedAgentId,
  onSelectAgent,
  onRefreshAgents,
}: AgentSidebarProps) {
  return (
    <aside className="agent-sidebar">
      <ModelSelector
        models={models}
        loading={modelsLoading}
        error={modelsError}
        selectedModel={selectedModel}
        onSelectModel={onSelectModel}
        onRefresh={onRefreshModels}
        disabled={modelLocked}
      />

      <AgentList
        agents={agents}
        loading={agentsLoading}
        error={agentsError}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
        onRefresh={onRefreshAgents}
      />
    </aside>
  );
}
