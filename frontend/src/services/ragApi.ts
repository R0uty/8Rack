import type { RagIndexStatus } from "../types/rag";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export async function fetchRagStatus(): Promise<RagIndexStatus> {
  const res = await apiFetch("/api/rag/status");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { status?: RagIndexStatus } | null;
  if (!data?.status) throw new ApiError("Received an invalid response from the server", 502);
  return data.status;
}

/** Blocking — walks, chunks, and embeds the whole workspace before resolving. Can take a while
 * for a large folder. */
export async function reindex(): Promise<RagIndexStatus> {
  const res = await apiFetch("/api/rag/reindex", { method: "POST" });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { status?: RagIndexStatus } | null;
  if (!data?.status) throw new ApiError("Received an invalid response from the server", 502);
  return data.status;
}
