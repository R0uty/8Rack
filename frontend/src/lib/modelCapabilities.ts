import type { OllamaModel } from "../types/ollama";

/**
 * Whether a model can be used for chat/generation.
 *
 * Embedding-only models (nomic-embed-text and friends: `family: nomic-bert`,
 * `capabilities: ["embedding"]`) have no generative decoder at all - Ollama's own /api/chat
 * rejects them outright with `"<model>" does not support chat`. They exist here only to serve
 * the RAG index (see `EMBEDDING_MODEL` / `services/ragIndex.ts` on the backend), so listing
 * them in a chat/agent model picker is a guaranteed dead end.
 *
 * Fails **open**: `/api/tags` only started reporting `capabilities` in recent Ollama versions,
 * so a model that declares nothing at all is assumed chat-capable rather than hidden.
 */
export function isChatCapable(model: OllamaModel): boolean {
  if (!model.capabilities?.length) return true;
  return model.capabilities.includes("completion");
}

/** The chat/agent picker view of an installed-model list. */
export function chatCapableModels(models: OllamaModel[]): OllamaModel[] {
  return models.filter(isChatCapable);
}
