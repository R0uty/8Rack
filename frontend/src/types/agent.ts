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
}

export type AgentStatus = "online" | "offline";

export interface AgentWithStatus extends Agent {
  status: AgentStatus;
}
