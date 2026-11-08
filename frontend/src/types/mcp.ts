/** Mirror of backend/src/types/mcp.ts. */
export type McpServerState = "checking" | "online" | "error" | "misconfigured";

export interface McpToolInfo {
  /** The catalog id 8Rack assigns - `<serverId>.<name>` - used to toggle the tool and by agents. */
  id: string;
  name: string;
  /** The server's own text - untrusted, and capped in length by the backend. */
  description: string;
  /** Discovered tools start disabled; a human enables each one before an agent can call it. */
  enabled: boolean;
}

export interface McpServerStatus {
  id: string;
  url: string;
  state: McpServerState;
  error?: string;
  tools: McpToolInfo[];
  skippedTools: number;
  checkedAt: number | null;
}
