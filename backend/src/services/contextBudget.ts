import type { ChatMessage } from "../types/ollama.js";

/**
 * Keeps what an agent call sends inside the context window. The whole transcript is resent on every
 * step, and Ollama doesn't refuse a prompt that's too long - it drops the beginning, which is the
 * system prompt with the tool instructions and the objective, and the model carries on without them.
 * Twenty tool results at up to 4 KB each pass a 16k window.
 *
 * So before each call, older tool results are shortened (oldest first) until the estimate fits. The
 * stored transcript is never changed - only what this one call sends. Kept whole: the first message
 * (the objective), every assistant turn and human note, and the newest KEEP_RECENT_RESULTS results,
 * which are what the agent is acting on right now.
 */

const KEEP_RECENT_RESULTS = 2;
/** How much of a shortened result stays - enough for the agent to recall what the call found. */
const ELIDED_PREVIEW_CHARS = 300;
/** A real tokenizer isn't available here. 3 characters per token over-counts for English prose and
 * under-counts little, which is the safe direction; calibrate() tightens it from Ollama's own count. */
const DEFAULT_CHARS_PER_TOKEN = 3;

let charsPerToken = DEFAULT_CHARS_PER_TOKEN;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / charsPerToken);
}

/** Feeds back what Ollama actually counted for a prompt of `chars` characters. Smoothed, and never
 * allowed above 4 (the estimate must not get optimistic from one unusually dense prompt). */
export function calibrate(chars: number, promptTokens: number | undefined): void {
  if (!promptTokens || promptTokens <= 0 || chars <= 0) return;
  const observed = chars / promptTokens;
  charsPerToken = Math.min(4, Math.max(1.5, charsPerToken * 0.7 + observed * 0.3));
}

/** For tests. */
export function resetCalibration(): void {
  charsPerToken = DEFAULT_CHARS_PER_TOKEN;
}

function elide(content: string): string {
  let tool = "tool";
  let success: unknown;
  let preview = content;
  try {
    const parsed = JSON.parse(content) as { tool?: unknown; success?: unknown; stdout?: unknown; message?: unknown; error?: unknown };
    if (typeof parsed.tool === "string") tool = parsed.tool;
    success = parsed.success;
    const body = [parsed.stdout, parsed.message, parsed.error].find((v): v is string => typeof v === "string" && v.trim() !== "");
    if (body !== undefined) preview = body;
  } catch {
    // Not JSON - preview the raw text.
  }
  return JSON.stringify({
    tool,
    ...(success === undefined ? {} : { success }),
    elided: true,
    note: "Older result shortened to fit the context window. The start of it:",
    preview: preview.length > ELIDED_PREVIEW_CHARS ? `${preview.slice(0, ELIDED_PREVIEW_CHARS)}…` : preview,
  });
}

export interface FitResult {
  messages: ChatMessage[];
  /** How many tool results were shortened for this call. */
  elided: number;
  /** Estimated prompt tokens after fitting. */
  estimatedTokens: number;
}

/**
 * @param fixedChars  everything sent besides `messages` - system prompt plus tools preamble
 * @param budgetTokens  the window minus room for the reply
 */
export function fitToContext(messages: ChatMessage[], fixedChars: number, budgetTokens: number): FitResult {
  const total = (list: ChatMessage[]) => fixedChars + list.reduce((sum, m) => sum + m.content.length, 0);
  let out = messages;
  let elided = 0;

  if (estimateTokens(total(out)) > budgetTokens) {
    out = [...messages];
    const toolIndexes = out.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i > 0);
    const candidates = toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT_RESULTS));
    for (const i of candidates) {
      if (estimateTokens(total(out)) <= budgetTokens) break;
      const shortened = elide(out[i].content);
      if (shortened.length >= out[i].content.length) continue;
      out[i] = { ...out[i], content: shortened };
      elided++;
    }
  }

  return { messages: out, elided, estimatedTokens: estimateTokens(total(out)) };
}
