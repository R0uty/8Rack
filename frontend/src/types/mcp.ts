/** Mirror of backend/src/types/mcp.ts. */
export type McpServerState = "checking" | "online" | "error" | "misconfigured";

export interface McpToolInfo {
  name: string;
  /** The server's own text - untrusted, and capped in length by the backend. */
  description: string;
}

export interface McpServerStatus {
  id: string;
  url: string;
  /** True for the server named by MCP_RAG_SERVER, which serves the knowledge base. */
  knowledgeBase: boolean;
  state: McpServerState;
  error?: string;
  tools: McpToolInfo[];
  skippedTools: number;
  checkedAt: number | null;
}
