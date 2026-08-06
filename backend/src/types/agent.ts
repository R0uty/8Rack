export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  icon: string;
  color: string;
  /** Admin-level toggle for whether this agent is offered at all, independent of model availability. */
  enabled: boolean;
  /** Names of tools (see types/tool.ts) this agent may use. */
  tools?: string[];
  /** Ids of exec tools (see types/execTool.ts) this agent may request via the Orchestrator.
   * Omitted means every enabled exec tool is available (unrestricted); an empty array means none. */
  execTools?: string[];
}

export type AgentStatus = "online" | "offline";

/** An Agent annotated with its live availability, computed by checking `model` against Ollama. */
export interface AgentWithStatus extends Agent {
  status: AgentStatus;
}

/** A config file under data/agents/ that failed to load (bad JSON, missing fields, duplicate id). */
export interface AgentConfigWarning {
  file: string;
  reason: string;
}
