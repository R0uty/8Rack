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
  enabled: boolean;
  tools?: string[];
  /** Ids of exec tools (see types/execTool.ts) this agent may request via the Orchestrator.
   * Omitted means every enabled exec tool is available (unrestricted); an empty array means none. */
  execTools?: string[];
}

export type AgentStatus = "online" | "offline";

export interface AgentWithStatus extends Agent {
  status: AgentStatus;
}

/** A config file under backend/data/agents/ that failed to load (bad JSON, missing fields,
 * duplicate id) - see agentManager.ts#getAgentConfigWarnings. */
export interface AgentConfigWarning {
  file: string;
  reason: string;
}
