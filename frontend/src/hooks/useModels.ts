import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchModels } from "../services/modelsApi";
import { chatCapableModels } from "../lib/modelCapabilities";
import type { OllamaModel } from "../types/ollama";

export function useModels() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setModels(await fetchModels());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load models");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Every consumer of `models` is a chat or agent model picker, so the chat-capable filter lives
  // here rather than at each call site - an embedding-only model in any of them can only fail.
  // `allModels` keeps the unfiltered list available (e.g. for an embedding-model picker).
  const chatModels = useMemo(() => chatCapableModels(models), [models]);

  return { models: chatModels, allModels: models, loading, error, refresh };
}
