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
  /** Overrides the agent's own configured `tools` for this request - omit to activate whatever
   * tools the agent's config already lists (see the toolsPreamble caveat below). */
  tools?: string[];
  keepAlive?: string;
  /** Appended after the agent's own systemPrompt — used by the Orchestrator to describe available
   * exec tools and the JSON request format, without the agent's own config needing to know about it. */
  toolsPreamble?: string;
  /** Overrides the agent's configured model for this request — the agent's own model stays its
   * default (nothing here mutates the agent config), this is purely a per-request choice. */
  model?: string;
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
  // The offline gate only applies to the agent's own configured model — a request overriding to a
  // different model shouldn't be blocked by the *default* model being unavailable. Ollama itself
  // still errors normally if the overridden model turns out not to be installed either, same as
  // the model-only (no agent) chat path already relies on.
  if (!request.model && agent.status === "offline") throw new AgentOfflineError(agent.id, agent.model);

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
    model: request.model ?? agent.model,
    messages,
    options,
    keep_alive: request.keepAlive,
  };

  // Falls back to the agent's own configured tools when the request doesn't specify any, so
  // selecting an agent with `tools` set activates them automatically instead of requiring the
  // caller to look them up and pass them through every time. Only when toolsPreamble is absent,
  // though - that field is toolsPreamble's own tell for "this call came from the Orchestrator"
  // (see its own doc comment above), which speaks a completely separate plain-text tool-request
  // convention and never uses Ollama's native tool_calls mechanism - activating both at once on
  // the same request would risk the model replying in whichever format it prefers instead of the
  // one the Orchestrator actually parses.
  const tools = request.tools ?? (request.toolsPreamble ? undefined : agent.tools);

  if (tools?.length) {
    const { specs, unknown } = resolveOllamaTools(tools);
    if (unknown.length) throw new UnknownToolError(unknown);
    yield* streamChatWithTools({ ...chatRequest, tools: specs }, signal);
  } else {
    yield* streamChat(chatRequest, signal);
  }
}
