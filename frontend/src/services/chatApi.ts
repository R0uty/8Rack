import type { ChatOptions, ChatRole, ToolCallInfo } from "../types/chat";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

interface ChatRequestPayload {
  /** When set, routes through POST /api/agents/:id/chat — the backend supplies the systemPrompt
   * (and, absent `model` below, the agent's own configured model too). */
  agentId?: string;
  /** Required when agentId is omitted. When agentId is set, this overrides the agent's own
   * configured model for this request only — the agent's config/default is never mutated. */
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
  const body = { model, messages, options, keepAlive, tools };

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