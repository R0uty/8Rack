import type { OllamaModel } from "../types/ollama";
import type { ChatOptions, ChatRole, ToolCallInfo } from "../types/chat";
import type { AgentConfigWarning, AgentWithStatus } from "../types/agent";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

export { ApiError };

export interface AgentsResponse {
  agents: AgentWithStatus[];
  warnings: AgentConfigWarning[];
}

export async function fetchModels(): Promise<OllamaModel[]> {
  const res = await apiFetch("/api/models");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { models?: OllamaModel[] } | null;
  if (!data?.models) throw new ApiError("Received an invalid response from the server", 502);
  return data.models;
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

interface ChatRequestPayload {
  /** When set, routes through POST /api/agents/:id/chat — the backend supplies model + systemPrompt. */
  agentId?: string;
  /** Required when agentId is omitted; ignored (the agent's own model is used) otherwise. */
  model?: string;
  messages: { role: ChatRole; content: string }[];
  options?: ChatOptions;
  keepAlive?: string;
  /** Names of registered backend tools the model may call for this request. */
  tools?: string[];
}

interface ChatStreamLine {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  };
  done?: boolean;
  error?: string;
}

export interface ChatStreamEvent {
  role: "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallInfo[];
  done: boolean;
}

/**
 * Streams a chat completion, invoking onEvent for each NDJSON line as it arrives. A line may be
 * a normal assistant content delta, a tool_calls announcement, or a tool result (role: "tool") —
 * see backend/src/services/ollama.ts#streamChatWithTools for the shapes this mirrors.
 * Pass an AbortSignal to allow the caller to cancel an in-flight request.
 */
export async function streamChat(
  payload: ChatRequestPayload,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { agentId, model, messages, options, keepAlive, tools } = payload;
  const url = agentId ? `/api/agents/${encodeURIComponent(agentId)}/chat` : "/api/chat";
  const body = agentId ? { messages, options, keepAlive, tools } : { model, messages, options, keepAlive, tools };

  const res = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) await throwForErrorResponse(res);

  await readNdjsonStream(res, (line) => {
    let parsed: ChatStreamLine;
    try {
      parsed = JSON.parse(line) as ChatStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.error) throw new ApiError(parsed.error, 502);
    onEvent({
      role: parsed.message?.role === "tool" ? "tool" : "assistant",
      content: parsed.message?.content ?? "",
      toolCalls: parsed.message?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      done: parsed.done ?? false,
    });
  });
}
