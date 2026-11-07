import type { Agent, AgentConfigWarning, AgentWithStatus } from "../types/agent";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export interface AgentsResponse {
  agents: AgentWithStatus[];
  warnings: AgentConfigWarning[];
}

async function unwrapAgentsResponse(res: Response): Promise<AgentsResponse> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as
    | { agents?: AgentWithStatus[]; warnings?: AgentConfigWarning[] }
    | null;
  if (!data?.agents) throw new ApiError("Received an invalid response from the server", 502);
  return { agents: data.agents, warnings: data.warnings ?? [] };
}

export async function fetchAgents(): Promise<AgentsResponse> {
  return unwrapAgentsResponse(await apiFetch("/api/agents"));
}

/** Forces the backend to re-read agent config files from disk and re-check their models against Ollama. */
export async function reloadAgents(): Promise<AgentsResponse> {
  return unwrapAgentsResponse(await apiFetch("/api/agents/reload", { method: "POST" }));
}

async function unwrapAgentResponse(res: Response): Promise<AgentWithStatus> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { agent?: AgentWithStatus } | null;
  if (!data?.agent) throw new ApiError("Received an invalid response from the server", 502);
  return data.agent;
}

export async function createAgent(agent: Agent): Promise<AgentWithStatus> {
  const res = await apiFetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
  return unwrapAgentResponse(res);
}

export async function updateAgent(id: string, agent: Agent): Promise<AgentWithStatus> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
  return unwrapAgentResponse(res);
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await throwForErrorResponse(res);
}