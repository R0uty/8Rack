import { getAgent } from "./agentManager.js";
import { resolveOllamaTools, streamChat, streamChatWithTools } from "./ollama.js";
import { AgentDisabledError, AgentNotFoundError, AgentOfflineError, UnknownToolError } from "./errors.js";
import type { ChatMessage, ChatOptions, ChatResponseChunk } from "../types/ollama.js";

export interface AgentChatRequest {
  agentId: string;
  /** Conversation history (user/assistant turns only) — the agent's systemPrompt is injected automatically. */
  messages: ChatMessage[];
  /** Per-request overrides layered on top of the agent's own temperature/topP/maxTokens. */
  options?: ChatOptions;
  tools?: string[];
  keepAlive?: string;
  /** Appended after the agent's own systemPrompt — used by the Orchestrator to describe available
   * exec tools and the JSON request format, without the agent's own config needing to know about it. */
  toolsPreamble?: string;
}

/**
 * The reusable Chat Service: given an agent ID and a user prompt/history, loads that agent's config,
 * injects its system prompt, and streams a completion from its configured Ollama model. This is the
 * one place agent-driven chat requests get assembled, so future multi-agent orchestration can call
 * it directly instead of going through the HTTP route.
 */
export async function* streamAgentChat(
  request: AgentChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatResponseChunk> {
  const agent = await getAgent(request.agentId);
  if (!agent) throw new AgentNotFoundError(request.agentId);
  if (!agent.enabled) throw new AgentDisabledError(agent.id);
  if (agent.status === "offline") throw new AgentOfflineError(agent.id, agent.model);

  const systemPrompt = request.toolsPreamble
    ? `${agent.systemPrompt}\n\n${request.toolsPreamble}`
    : agent.systemPrompt;
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...request.messages];
  const options: ChatOptions = {
    temperature: agent.temperature,
    top_p: agent.topP,
    // maxTokens: 0 means "unlimited" (num_predict omitted), same convention as the frontend settings.
    ...(agent.maxTokens > 0 ? { num_predict: agent.maxTokens } : {}),
    ...request.options,
  };

  const chatRequest = {
    model: agent.model,
    messages,
    options,
    keep_alive: request.keepAlive,
  };

  if (request.tools?.length) {
    const { specs, unknown } = resolveOllamaTools(request.tools);
    if (unknown.length) throw new UnknownToolError(unknown);
    yield* streamChatWithTools({ ...chatRequest, tools: specs }, signal);
  } else {
    yield* streamChat(chatRequest, signal);
  }
}
