import { env } from "../config/env.js";
import { getAgent } from "./agentManager.js";
import { streamChat } from "./ollama.js";
import { calibrate, fitToContext } from "./contextBudget.js";
import { AgentDisabledError, AgentNotFoundError, AgentOfflineError } from "./errors.js";
import type { ChatMessage, ChatOptions, ChatResponseChunk } from "../types/ollama.js";

export interface AgentChatRequest {
  agentId: string;
  /** Conversation history (user/assistant turns only) — the agent's systemPrompt is injected automatically. */
  messages: ChatMessage[];
  /** Per-request overrides layered on top of the agent's own temperature/topP/maxTokens. */
  options?: ChatOptions;
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
  const options: ChatOptions = {
    num_ctx: env.ollamaNumCtx,
    temperature: agent.temperature,
    top_p: agent.topP,
    // maxTokens: 0 means "unlimited" (num_predict omitted), same convention as the frontend settings.
    ...(agent.maxTokens > 0 ? { num_predict: agent.maxTokens } : {}),
    ...request.options,
  };

  // Room for the reply comes off the top: a prompt that fills the window leaves the model nothing
  // to answer with. num_predict when the agent sets one (capped), else an eighth of the window.
  const numCtx = options.num_ctx ?? env.ollamaNumCtx;
  const replyReserve = options.num_predict ? Math.min(options.num_predict, numCtx / 4) : numCtx / 8;
  const fit = fitToContext(request.messages, systemPrompt.length, Math.floor(numCtx - replyReserve));
  if (fit.elided > 0) {
    console.info(`[chat] ${agent.id}: shortened ${fit.elided} older tool result(s) to fit ${numCtx} tokens (~${fit.estimatedTokens} sent).`);
  }
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...fit.messages];
  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  const chatRequest = {
    model: request.model ?? agent.model,
    messages,
    options,
    keep_alive: request.keepAlive,
  };

  const stream = streamChat(chatRequest, signal);

  for await (const chunk of stream) {
    if (chunk.done) {
      calibrate(promptChars, chunk.prompt_eval_count);
      warnIfPromptCut(agent.id, chunk.prompt_eval_count, options.num_ctx);
    }
    yield chunk;
  }
}

/** Ollama doesn't fail a prompt that's too long for num_ctx - it drops the beginning (the system
 * prompt and the task) and answers anyway, usually with nonsense. All it reports is how many prompt
 * tokens it read, so a count at the limit is the only sign. */
function warnIfPromptCut(agentId: string, promptTokens: number | undefined, numCtx: number | undefined): void {
  if (promptTokens === undefined || numCtx === undefined) return;
  if (promptTokens >= numCtx * 0.95) {
    console.warn(
      `[chat] ${agentId}: the prompt filled the whole context window (${promptTokens} of ${numCtx} tokens) - ` +
        "Ollama has probably cut its beginning. Raise OLLAMA_NUM_CTX.",
    );
  }
}
