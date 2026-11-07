import type { McpServerStatus } from "../types/mcp";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

async function readServers(res: Response): Promise<McpServerStatus[]> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { servers?: McpServerStatus[] } | null;
  if (!Array.isArray(data?.servers)) throw new ApiError("Received an invalid response from the server", 502);
  return data.servers;
}

export async function fetchMcpServers(): Promise<McpServerStatus[]> {
  return readServers(await apiFetch("/api/mcp/servers"));
}

/** Blocking - the backend connects to every configured server before answering. */
export async function refreshMcpServers(): Promise<McpServerStatus[]> {
  return readServers(await apiFetch("/api/mcp/servers/refresh", { method: "POST" }));
}
