export interface RagIndexStatus {
  indexedAt: number | null;
  fileCount: number;
  chunkCount: number;
  embeddingModel: string;
  /** As the index's owner sees it - for an MCP server, a path on that server's machine. */
  workspaceRoot: string;
  /** The MCP server serving this index (MCP_RAG_SERVER). Absent for the local index. */
  server?: string;
}
