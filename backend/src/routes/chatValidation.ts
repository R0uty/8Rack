import type { ChatMessage } from "../types/ollama.js";

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
