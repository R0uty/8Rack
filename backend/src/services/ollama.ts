import { env } from "../config/env.js";
import {
  EmbeddingModelUnavailableError,
  OllamaConnectionError,
  OllamaModelNotFoundError,
  OllamaRequestError,
  OllamaTimeoutError,
  RequestCancelledError,
} from "./errors.js";
import { getTool } from "../extensions/toolRegistry.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponseChunk,
  OllamaModel,
  OllamaToolSpec,
  ToolCall,
} from "../types/ollama.js";

const BASE_URL = env.ollamaBaseUrl;

/**
 * `timeoutMs`, when given, bounds the whole call and is combined with any caller-supplied
 * `init.signal` via AbortSignal.any - used for the quick, non-generation endpoints (/api/tags,
 * /api/embed) where an unbounded hang has no other guard. /api/chat deliberately doesn't pass one
 * here - streamChat implements its own idle-based (not fixed-duration) timeout instead, since a
 * single long generation can legitimately run well past any fixed bound.
 */
async function ollamaFetch(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const signal =
    timeoutMs !== undefined
      ? init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      : (init?.signal ?? undefined);
  try {
    return await fetch(`${BASE_URL}${path}`, { ...init, signal });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new OllamaTimeoutError(err);
    if (err instanceof Error && err.name === "AbortError") throw new RequestCancelledError();
    throw new OllamaConnectionError(err);
  }
}

function isModelNotFoundMessage(message: string): boolean {
  return message.toLowerCase().includes("not found");
}

async function throwForErrorResponse(res: Response, model?: string): Promise<never> {
  let message = `Ollama request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // response body wasn't JSON; keep the default message
  }

  if (res.status === 404 && model && isModelNotFoundMessage(message)) {
    throw new OllamaModelNotFoundError(model);
  }
  throw new OllamaRequestError(message, res.status);
}

/** List models currently installed in the local Ollama instance. */
export async function listModels(): Promise<OllamaModel[]> {
  const res = await ollamaFetch("/api/tags", undefined, env.ollamaRequestTimeoutMs);
  if (!res.ok) await throwForErrorResponse(res);

  const data = (await res.json()) as { models: OllamaModel[] };
  return data.models;
}

/**
 * Embeds a batch of strings with the given model via POST /api/embed. Most chat/coder models
 * don't declare Ollama's "embedding" capability and get flatly rejected (confirmed live against
 * this project's own installed models) - that specific failure is surfaced as
 * EmbeddingModelUnavailableError so callers (services/ragIndex.ts) can give an actionable message
 * instead of a raw Ollama error string.
 */
export async function embed(model: string, input: string[]): Promise<number[][]> {
  const res = await ollamaFetch(
    "/api/embed",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
    },
    env.ollamaRequestTimeoutMs,
  );

  if (!res.ok) {
    let message = `Ollama request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // response body wasn't JSON; keep the default message
    }
    if (isModelNotFoundMessage(message) || message.toLowerCase().includes("does not support embeddings")) {
      throw new EmbeddingModelUnavailableError(model);
    }
    throw new OllamaRequestError(message, res.status);
  }

  const data = (await res.json()) as { embeddings?: number[][] };
  if (!data.embeddings) throw new OllamaRequestError("Ollama returned no embeddings", 502);
  return data.embeddings;
}

/**
 * Stream a chat completion from Ollama.
 * Yields one ChatResponseChunk per NDJSON line as they arrive.
 *
 * Bounded by *inactivity*, not total duration (env.ollamaChatIdleTimeoutMs, default 5 minutes,
 * same reasoning as the frontend's own IDLE_TIMEOUT_MS) - the timer resets on every chunk actually
 * received (including the very first one), so a large local model that's still slowly producing
 * tokens is never killed by this; only a connection gone genuinely silent (Ollama wedged mid
 * model-load, or hung) is. Combined with the caller's own `signal` via AbortSignal.any so either
 * one stops the stream - `idleController.signal.aborted` is checked in both catch blocks to tell
 * "we timed out" apart from "the caller cancelled us", since both surface as the same AbortError
 * once fetch/the reader actually throws.
 */
export async function* streamChat(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatResponseChunk> {
  const idleController = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, idleController.signal]) : idleController.signal;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), env.ollamaChatIdleTimeoutMs);
  };

  try {
    armIdleTimer();
    let res: Response;
    try {
      res = await ollamaFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, stream: true }),
        signal: combinedSignal,
      });
    } catch (err) {
      if (idleController.signal.aborted) throw new OllamaTimeoutError(err);
      throw err;
    }

    if (!res.ok) await throwForErrorResponse(res, request.model);
    if (!res.body) throw new OllamaRequestError("Ollama returned an empty response body", 502);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const parseLine = (line: string): ChatResponseChunk => {
      try {
        return JSON.parse(line) as ChatResponseChunk;
      } catch {
        throw new OllamaRequestError("Received an invalid response from Ollama", 502);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        armIdleTimer();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          yield parseLine(trimmed);
        }
      }
      if (buffer.trim()) {
        yield parseLine(buffer.trim());
      }
    } catch (err) {
      if (idleController.signal.aborted) throw new OllamaTimeoutError(err);
      if (err instanceof Error && err.name === "AbortError") throw new RequestCancelledError();
      throw err;
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(idleTimer);
  }
}

/** Non-streaming convenience wrapper: collects a full chat completion. */
export async function chat(request: ChatRequest): Promise<ChatResponseChunk> {
  let last: ChatResponseChunk | undefined;
  let content = "";

  for await (const chunk of streamChat(request)) {
    content += chunk.message?.content ?? "";
    last = chunk;
  }

  if (!last) throw new OllamaRequestError("Ollama returned no data", 502);
  return { ...last, message: { role: "assistant", content } };
}

/**
 * Resolves registered tool names to Ollama's native function-calling schema.
 * toolRegistry.ts stays provider-agnostic (see DEVELOPMENT.md); this conversion is the
 * one place that couples the generic Tool shape to Ollama's specific wire format.
 */
export function resolveOllamaTools(toolNames: string[]): {
  specs: OllamaToolSpec[];
  unknown: string[];
} {
  const specs: OllamaToolSpec[] = [];
  const unknown: string[] = [];

  for (const name of toolNames) {
    const tool = getTool(name);
    if (!tool) {
      unknown.push(name);
      continue;
    }
    specs.push({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    });
  }

  return { specs, unknown };
}

/**
 * Ollama only parses tool_calls out of the model's output if it's wrapped in
 * <tool_call></tool_call> tags, per the model's chat template. Several small/quantized local
 * models (e.g. qwen2.5-coder) reliably produce the right {name, arguments} JSON but skip the
 * wrapper tags, so Ollama passes it through as plain content instead of structured tool_calls.
 * This recovers those calls so tool-calling still works with models that are JSON-correct but
 * tag-noncompliant.
 */
function tryParseFallbackToolCall(content: string, validNames: Set<string>): ToolCall | undefined {
  let text = content.trim();

  const tagMatch = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (tagMatch) text = tagMatch[1].trim();

  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  if (!text.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(text) as { name?: unknown; arguments?: unknown };
    if (
      typeof parsed.name === "string" &&
      validNames.has(parsed.name) &&
      parsed.arguments &&
      typeof parsed.arguments === "object"
    ) {
      return { function: { name: parsed.name, arguments: parsed.arguments as Record<string, unknown> } };
    }
  } catch {
    // Not a tool call - just a normal text answer that happens not to parse as JSON.
  }
  return undefined;
}

const MAX_TOOL_ROUNDS = 4;

/**
 * Like streamChat, but when the model responds with tool_calls, executes them against
 * toolRegistry, appends the assistant + tool-result messages, and continues the conversation
 * automatically. Tool-call and tool-result messages are yielded as synthetic chunks (done: false)
 * so the client can render them, in addition to the model's own streamed chunks.
 */
export async function* streamChatWithTools(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatResponseChunk> {
  const messages: ChatMessage[] = [...request.messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantContent = "";
    const toolCalls: ToolCall[] = [];

    for await (const chunk of streamChat({ ...request, messages }, signal)) {
      yield chunk;
      assistantContent += chunk.message?.content ?? "";
      if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
    }

    if (toolCalls.length === 0 && request.tools?.length) {
      const validNames = new Set(request.tools.map((t) => t.function.name));
      const fallback = tryParseFallbackToolCall(assistantContent, validNames);
      if (fallback) {
        toolCalls.push(fallback);
        yield {
          model: request.model,
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: "", tool_calls: toolCalls },
          done: false,
        };
      }
    }

    if (toolCalls.length === 0 || !request.tools?.length) return;

    messages.push({ role: "assistant", content: assistantContent, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const tool = getTool(call.function.name);
      const result = tool
        ? await tool.execute(call.function.arguments)
        : { toolName: call.function.name, output: null, error: `Unknown tool "${call.function.name}"` };

      const toolMessage: ChatMessage = {
        role: "tool",
        content: JSON.stringify(result.error ? { error: result.error } : result.output),
      };
      messages.push(toolMessage);

      yield {
        model: request.model,
        created_at: new Date().toISOString(),
        message: toolMessage,
        done: false,
      };
    }
  }
}
