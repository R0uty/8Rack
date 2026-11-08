/** MCP servers 8Rack connects to as a client - see services/mcpClient.ts and "Planned: MCP servers as the
 * tool and RAG providers" in DEVELOPMENT.md. */

/**
 * - `checking`: configured, not answered yet (startup, or a check in progress for the first time)
 * - `online`: connected and listed its tools at `checkedAt`
 * - `error`: configured correctly, but the last check failed - unreachable, timed out, or rejected the token
 * - `misconfigured`: the `.env` entry itself is wrong, so 8Rack never tries to connect
 */
export type McpServerState = "checking" | "online" | "error" | "misconfigured";

export interface McpToolInfo {
  /** The catalog id 8Rack assigns this tool - `<serverId>.<name>`. What an agent (and the
   * Orchestrator's allowlist) refer to it by, kept distinct from the server's own `name` so two
   * servers offering a `nmap` tool don't collide. */
  id: string;
  name: string;
  /** The server's own text - untrusted, and capped in length. */
  description: string;
  /** A discovered tool starts disabled; a human enables it before any agent can call it. Persisted. */
  enabled: boolean;
}

export interface McpServerStatus {
  id: string;
  /** Empty when the entry was too malformed to find one. Never carries credentials - those are rejected. */
  url: string;
  state: McpServerState;
  error?: string;
  tools: McpToolInfo[];
  /** Tools the server offered that 8Rack won't list - a name outside the accepted characters, a duplicate,
   * or past the per-server cap. */
  skippedTools: number;
  checkedAt: number | null;
}
