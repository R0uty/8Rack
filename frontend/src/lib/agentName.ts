import type { AgentWithStatus } from "../types/agent";

/** An agent's display name, falling back to its id for one that no longer exists. */
export function agentName(agents: Pick<AgentWithStatus, "id" | "name">[], agentId: string | undefined): string {
  if (!agentId) return "Manual request";
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}
