import type { ChatMessage, ChatOptions } from "../types/ollama.js";

/** Shared request-body validation for every route that accepts a chat message history. */
export function isValidMessages(messages: unknown): messages is ChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (m) =>
        m &&
        typeof m === "object" &&
        typeof (m as ChatMessage).content === "string" &&
        ["system", "user", "assistant"].includes((m as ChatMessage).role),
    )
  );
}

export function isValidToolNames(tools: unknown): tools is string[] {
  return Array.isArray(tools) && tools.every((t) => typeof t === "string");
}

const MAX_NUM_CTX = 131_072;
const MAX_NUM_PREDICT = 131_072;

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

/**
 * `options` was previously cast straight through to Ollama with no validation at all - an
 * absurdly large num_ctx/num_predict makes the local Ollama allocate that much context RAM per
 * request, and a garbage temperature/top_p was silently accepted too. Only the four known fields
 * survive, each clamped into a safe range; anything else (unknown keys, wrong types,
 * NaN/Infinity) is silently dropped rather than rejecting the whole chat request - these are
 * performance/resource knobs, not something worth a hard 400 over.
 */
export function sanitizeChatOptions(options: unknown): ChatOptions | undefined {
  if (!options || typeof options !== "object") return undefined;
  const raw = options as Record<string, unknown>;
  const sanitized: ChatOptions = {};

  const temperature = clampNumber(raw.temperature, 0, 2);
  if (temperature !== undefined) sanitized.temperature = temperature;

  const topP = clampNumber(raw.top_p, 0, 1);
  if (topP !== undefined) sanitized.top_p = topP;

  // -1 (generate until the model stops on its own) and -2 (fill the context window) are
  // meaningful Ollama sentinels, not out-of-range values to clamp away.
  if (raw.num_predict === -1 || raw.num_predict === -2) {
    sanitized.num_predict = raw.num_predict;
  } else {
    const numPredict = clampNumber(raw.num_predict, 0, MAX_NUM_PREDICT);
    if (numPredict !== undefined) sanitized.num_predict = Math.trunc(numPredict);
  }

  const numCtx = clampNumber(raw.num_ctx, 1, MAX_NUM_CTX);
  if (numCtx !== undefined) sanitized.num_ctx = Math.trunc(numCtx);

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
