import type { OllamaModel } from "../types/ollama";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export async function fetchModels(): Promise<OllamaModel[]> {
  const res = await apiFetch("/api/models");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { models?: OllamaModel[] } | null;
  if (!data?.models) throw new ApiError("Received an invalid response from the server", 502);
  return data.models;
}