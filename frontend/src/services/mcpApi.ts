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

/** Enables or disables a discovered MCP tool by its `<server>.<tool>` id. Returns the updated server
 * list so the panel reflects the new state without a full re-check. */
export async function setMcpToolEnabled(id: string, enabled: boolean): Promise<McpServerStatus[]> {
  return readServers(
    await apiFetch(`/api/mcp/tools/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  );
}
